import { Logger } from '@nestjs/common';
import { OPTIONAL_DEPS_METADATA, PARAMTYPES_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, ModuleRef } from '@nestjs/core';
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
import { HubPoolIdentityRepository } from '@/modules/hub-pool/hub-pool-identity.repository';
import { HubPoolIdentityService } from '@/modules/hub-pool/hub-pool-identity.service';
import { McpService } from '@/modules/mcp/mcp.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { QueueFactory } from '@/modules/queue/queue.factory';
import { RegistrationService } from '@/modules/registration/registration.service';
import { StatusReportService } from '@/modules/status-report/status-report.service';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
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
 * the process is replaced: RabbitMQ, Docker, the app and pool identity rows in Postgres, Tailscale and
 * the sqlite cache.
 */
describe('AppModule wiring', () => {
  let moduleRef: TestingModule;
  let notifier: AgentNotifyService;
  const appsRepository = mock<AppsRepository>();
  const appEventsQueue = mock<AppEventsQueue>();
  const docker = { listContainers: vi.fn() };
  const poolIdentityRows = { get: vi.fn(), insertIfAbsent: vi.fn(), replaceKeys: vi.fn() };
  const tailscale = mock<TailscaleService>();
  tailscale.getStatusCached.mockResolvedValue(fromPartial({ connected: false }));
  const fetchMock = vi.fn();

  beforeAll(async () => {
    for (const [name, value] of Object.entries(HUB_ENV)) {
      vi.stubEnv(name, value);
    }
    // `notify` reads these on every call, so a shell that turns wakes off or raises the floor
    // must not fail these tests.
    vi.stubEnv('AGENT_WEBHOOK_ENABLED', 'true');
    vi.stubEnv('AGENT_WEBHOOK_MIN_URGENCY', 'low');

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
      .overrideProvider(HubPoolIdentityRepository)
      .useValue(poolIdentityRows)
      .overrideProvider(TailscaleService)
      .useValue(tailscale)
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

  // `@Optional()` turns a dependency Nest cannot match into `undefined` without a word. That hid the
  // notifier from five services (#2081) and the pool identity from the status file (#2099), whose
  // `HubPoolIdentityService | undefined` parameter was emitted as `Object`.
  it("resolves every optional dependency of the Hub's own providers", () => {
    const unresolved: string[] = [];
    for (const wrapper of moduleRef.get(DiscoveryService).getProviders()) {
      const metatype = wrapper.metatype;
      // Nest's own Logger takes an optional context string and options, which are never providers.
      if (typeof metatype !== 'function' || wrapper.inject || !wrapper.instance || metatype === Logger) {
        continue;
      }
      const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, metatype) ?? [];
      const designTypes: unknown[] = Reflect.getMetadata(PARAMTYPES_METADATA, metatype) ?? [];
      const declared: Array<{ index: number; param: unknown }> = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, metatype) ?? [];
      const held = Object.values(wrapper.instance as object);
      for (const index of optional) {
        const raw = declared.find((dep) => dep.index === index)?.param ?? designTypes[index];
        const token = (raw as { forwardRef?: () => unknown } | undefined)?.forwardRef?.() ?? raw;
        // Every module gets a ModuleRef of its own, so compare by kind rather than by instance.
        if (token === ModuleRef) {
          if (!held.some((value) => value instanceof ModuleRef)) unresolved.push(`${metatype.name} parameter ${index} (ModuleRef)`);
          continue;
        }
        let dependency: unknown;
        try {
          dependency = token && token !== Object ? moduleRef.get(token as never, { strict: false }) : undefined;
        } catch {
          dependency = undefined;
        }
        if (!dependency || !held.includes(dependency)) {
          const tokenName = typeof token === 'function' ? token.name : String(token);
          unresolved.push(`${metatype.name} parameter ${index} (${tokenName})`);
        }
      }
    }

    expect(unresolved).toEqual([]);
  });

  it('gives the status file the shared pool identity and reads its UUID without minting one', async () => {
    const statusReport = moduleRef.get(StatusReportService, { strict: false });
    expect(Object.values(statusReport)).toContain(moduleRef.get(HubPoolIdentityService, { strict: false }));
    // The other sections read hardware, engines and containers. They take seconds without them.
    const sections = ['readSystem', 'readInference', 'readWorkloads'].map((section) =>
      vi.spyOn(statusReport as never as Record<string, () => Promise<unknown>>, section).mockResolvedValue(null),
    );

    poolIdentityRows.get.mockResolvedValue({
      id: 'self',
      nodeUuid: '2f8d0c8e-5c1a-4b7e-9f39-0d6a2b1c4e55',
      publicKey: 'pk',
      privateKeyEncrypted: 'sealed',
    });
    expect((await statusReport.buildReport()).connection?.poolNodeUuid).toBe('2f8d0c8e-5c1a-4b7e-9f39-0d6a2b1c4e55');

    // Every Hub writes this file every quarter hour. Most never use Hub Pool.
    poolIdentityRows.get.mockResolvedValue(undefined);
    expect((await statusReport.buildReport()).connection?.poolNodeUuid).toBeNull();
    expect(poolIdentityRows.insertIfAbsent).not.toHaveBeenCalled();
    for (const spy of sections) spy.mockRestore();
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
