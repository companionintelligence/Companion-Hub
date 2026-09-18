import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { SSEService } from '../sse.service';

describe('SSEService app stream', () => {
  let service: SSEService;

  beforeEach(() => {
    const config = mock<ConfigurationService>();
    config.getConfig.mockReturnValue({ version: '0.2.72' } as ReturnType<ConfigurationService['getConfig']>);
    service = new SSEService(mock<LoggerService>(), mock<DockerService>(), config);
  });

  afterEach(() => {
    // The constructor arms a one-minute topic sweep; drop it so vitest can exit.
    service.onApplicationShutdown();
  });

  const collect = (count: number) => firstValueFrom(service.getAppEventsObservable().pipe(take(count), toArray()));

  it('opens every subscription with a hub_hello carrying the running version', async () => {
    const [first] = await collect(1);
    expect(first.type).toBe('message');
    expect(JSON.parse(first.data as string)).toEqual({ event: 'hub_hello', version: '0.2.72' });
  });

  it('still delivers ordinary app events after the hello', async () => {
    const pending = collect(2);
    service.emit('app', { event: 'install_queue', active: null, queued: [] });
    const [, second] = await pending;
    expect(JSON.parse(second.data as string)).toEqual({ event: 'install_queue', active: null, queued: [] });
  });

  it('greets a second subscriber independently (a reconnecting tab gets its own hello)', async () => {
    const a = await collect(1);
    const b = await collect(1);
    expect(JSON.parse(a[0].data as string).event).toBe('hub_hello');
    expect(JSON.parse(b[0].data as string).event).toBe('hub_hello');
  });
});
