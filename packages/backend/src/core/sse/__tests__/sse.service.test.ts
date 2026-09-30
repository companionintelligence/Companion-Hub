import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { SSEService } from '../sse.service';

describe('SSEService app stream', () => {
  let service: SSEService;

  /** The service reads the image's build stamp once, when it is built, so the env is set first. */
  const createService = (stamp: Record<string, string> = {}) => {
    vi.stubEnv('CI_HUB_BUILD_VERSION', '');
    for (const [key, value] of Object.entries(stamp)) vi.stubEnv(key, value);
    const config = mock<ConfigurationService>();
    config.getConfig.mockReturnValue({ version: '0.2.72' } as ReturnType<ConfigurationService['getConfig']>);
    return new SSEService(mock<LoggerService>(), mock<DockerService>(), config);
  };

  beforeEach(() => {
    service = createService();
  });

  afterEach(() => {
    // The constructor arms a one-minute topic sweep; drop it so vitest can exit.
    service.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  const collect = (count: number) => firstValueFrom(service.getAppEventsObservable().pipe(take(count), toArray()));

  it('opens every subscription with a hub_hello carrying the running version', async () => {
    const [first] = await collect(1);
    expect(first.type).toBe('message');
    expect(JSON.parse(first.data as string)).toEqual({ event: 'hub_hello', version: '0.2.72' });
  });

  it('adds the image build stamp as buildVersion, beside the env-file version', async () => {
    service.onApplicationShutdown();
    service = createService({ CI_HUB_BUILD_VERSION: 'v0.2.78' });
    const [first] = await collect(1);
    expect(JSON.parse(first.data as string)).toEqual({ event: 'hub_hello', version: '0.2.72', buildVersion: '0.2.78' });
  });

  it('sends no buildVersion from an unstamped image, never the env-file version in its place', async () => {
    service.onApplicationShutdown();
    service = createService({ CI_HUB_VERSION: '0.2.75' });
    const [first] = await collect(1);
    expect(JSON.parse(first.data as string)).not.toHaveProperty('buildVersion');
  });

  it('still delivers ordinary app events after the hello', async () => {
    const pending = collect(2);
    service.emit('app', { event: 'install_queue', active: null, queued: [] });
    const [, second] = await pending;
    expect(JSON.parse(second.data as string)).toEqual({ event: 'install_queue', active: null, queued: [] });
  });

  it('reports whether a client is listening on the app topic', () => {
    expect(service.hasSubscribers('app')).toBe(false);

    const subscription = service.getAppEventsObservable().subscribe();
    expect(service.hasSubscribers('app')).toBe(true);

    subscription.unsubscribe();
    expect(service.hasSubscribers('app')).toBe(false);
  });

  it('greets a second subscriber independently (a reconnecting tab gets its own hello)', async () => {
    const a = await collect(1);
    const b = await collect(1);
    expect(JSON.parse(a[0].data as string).event).toBe('hub_hello');
    expect(JSON.parse(b[0].data as string).event).toBe('hub_hello');
  });
});
