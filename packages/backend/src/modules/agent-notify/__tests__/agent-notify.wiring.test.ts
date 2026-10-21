import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppModule } from '@/app.module';
import { CacheService } from '@/core/cache/cache.service';
import type { App } from '@/core/database/drizzle/types';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppStatusSyncService } from '@/modules/app-lifecycle/app-status-sync.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupsService } from '@/modules/backups/backups.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { McpService } from '@/modules/mcp/mcp.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { QueueFactory } from '@/modules/queue/queue.factory';
import { RegistrationService } from '@/modules/registration/registration.service';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { AgentNotifyService } from '../agent-notify.service';

/** What ConfigurationService refuses to start without. None of it is dialled: compile() opens no connections. */
const HUB_ENV: Record<string, string> = {
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '1',
  POSTGRES_DBNAME: 'wiring',
  POSTGRES_USERNAME: 'wiring',
  POSTGRES_PASSWORD: 'wiring',
  RABBITMQ_HOST: '127.0.0.1',
  RABBITMQ_USERNAME: 'wiring',
  RABBITMQ_PASSWORD: 'wiring',
  INTERNAL_IP: '127.0.0.1',
  CI_HUB_VERSION: '0.0.0',
  JWT_SECRET: 'wiring-test-secret-wiring-test-secret',
  CI_CLOUD_URL: 'http://127.0.0.1:1',
  DOMAIN: 'example.test',
  CI_HUB_APP_DATA_PATH: '/data/app-data',
  CI_HUB_FORWARD_AUTH_URL: 'http://ci-hub:5002/api/auth/traefik',
  DEMO_MODE: 'false',
  GUEST_DASHBOARD: 'false',
  ALLOW_ERROR_MONITORING: 'false',
  ALLOW_AUTO_THEMES: 'false',
  PERSIST_TRAEFIK_CONFIG: 'false',
  TZ: 'UTC',
  ADVANCED_SETTINGS: 'false',
  THEME_BASE: 'gray',
  THEME_COLOR: 'blue',
  EXPERIMENTAL_INSECURE_COOKIE: 'false',
  ROOT_FOLDER_HOST: '/opt/ci-hub',
};

const AGENT_URN = 'ci-openclaw:ci-marketplace';
const WAKE_URL = 'http://ci-openclaw:18789/hooks/wake';

/** The services that send wakes today. The scan below must find all of them, or it is checking nothing. */
const KNOWN_SENDERS = [AppStatusSyncService, AppLifecycleService, BackupsService, RegistrationService, SystemUpdateService, McpService];

/**
 * The real AppModule graph, so these tests see the module wiring the Hub runs with. Only what leaves
 * the process is replaced: RabbitMQ, Docker, the app rows in Postgres and the sqlite cache.
 */
describe('agent wake wiring in AppModule', () => {
  let moduleRef: TestingModule;
  let notifier: AgentNotifyService;
  const appsRepository = mock<AppsRepository>();
  const appEventsQueue = mock<AppEventsQueue>();
  const docker = { listContainers: vi.fn() };
  const fetchMock = vi.fn();

  beforeAll(async () => {
    for (const [name, value] of Object.entries(HUB_ENV)) {
      vi.stubEnv(name, value);
    }

    moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
      .overrideProvider(QueueFactory)
      .useValue(mock<QueueFactory>())
      .overrideProvider(AppEventsQueue)
      .useValue(appEventsQueue)
      .overrideProvider(RepoEventsQueue)
      .useValue(mock<RepoEventsQueue>())
      .overrideProvider(SystemEventsQueue)
      .useValue(mock<SystemEventsQueue>())
      .overrideProvider(DOCKERODE)
      .useValue(docker)
      .overrideProvider(AppsRepository)
      .useValue(appsRepository)
      .overrideProvider(CacheService)
      .useValue(mock<CacheService>())
      .compile();

    notifier = moduleRef.get(AgentNotifyService, { strict: false });
  });

  afterAll(async () => {
    await moduleRef?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    notifier._getDebounceMap().clear();
    notifier.registerWebhook(AGENT_URN, WAKE_URL, 'wake-secret');
  });

  afterEach(() => {
    notifier.unregisterWebhook(AGENT_URN);
    vi.unstubAllGlobals();
  });

  function wakeTexts(): string[] {
    return fetchMock.mock.calls.filter(([url]) => url === WAKE_URL).map(([, init]) => JSON.parse(String(init.body)).text as string);
  }

  it('gives every provider that asks for the notifier the one shared instance', () => {
    const senders = moduleRef
      .get(DiscoveryService)
      .getProviders()
      .filter((wrapper) => {
        const paramTypes: unknown[] =
          typeof wrapper.metatype === 'function' ? (Reflect.getMetadata('design:paramtypes', wrapper.metatype) ?? []) : [];
        return paramTypes.includes(AgentNotifyService);
      });

    const missing = senders.filter((wrapper) => !Object.values(wrapper.instance as object).includes(notifier)).map((wrapper) => String(wrapper.name));
    const found = senders.map((wrapper) => wrapper.metatype);

    expect(missing).toEqual([]);
    for (const sender of KNOWN_SENDERS) {
      expect(found).toContain(sender);
    }
  });

  it('wakes the agent when the status sync finds a running app crashed', async () => {
    appsRepository.getApps.mockResolvedValue([
      fromPartial<App>({
        id: 7,
        appName: 'cyberchef',
        appStoreSlug: 'ci-marketplace',
        status: 'running',
        config: {},
        updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    ]);
    appsRepository.updateAppByIdIfStatus.mockResolvedValue(true);
    docker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        State: 'exited',
        Status: 'Exited (137) 4 seconds ago',
        Labels: { 'ci-hub.managed': 'true', 'ci-hub.appurn': 'cyberchef:ci-marketplace' },
      },
    ]);

    await moduleRef.get(AppStatusSyncService, { strict: false }).syncAllAppStatuses();

    await vi.waitFor(() => expect(wakeTexts()).toHaveLength(1));
    expect(wakeTexts()[0]).toContain('app.crashed');
    expect(wakeTexts()[0]).toContain('cyberchef:ci-marketplace');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-OpenClaw-Token']).toBe('wake-secret');
  });

  it('wakes the agent when an app fails to start', async () => {
    appsRepository.getAppByUrn.mockResolvedValue(
      fromPartial<App>({ id: 8, appName: 'uptime-kuma', appStoreSlug: 'ci-marketplace', status: 'stopped', config: {} }),
    );
    appsRepository.updateAppById.mockResolvedValue(fromPartial<App>({}));
    appEventsQueue.unavailableReason.mockReturnValue(undefined);
    appEventsQueue.publish.mockResolvedValue({ success: false, message: 'pull access denied for nginx:tag-does-not-exist' });

    await moduleRef.get(AppLifecycleService, { strict: false }).startApp({
      appUrn: 'uptime-kuma:ci-marketplace',
      actor: { kind: 'exempt', principal: 'cli' },
    });

    await vi.waitFor(() => expect(wakeTexts()).toHaveLength(1));
    expect(wakeTexts()[0]).toContain('start_error');
    expect(wakeTexts()[0]).toContain('uptime-kuma:ci-marketplace');
  });
});
