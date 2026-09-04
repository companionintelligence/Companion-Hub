import { hubIntegrationSchema } from '@ci-hub/common/schemas';
import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AgentNotifyService } from '../agent-notify.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('AgentNotifyService', () => {
  let service: AgentNotifyService;
  let logger: MockProxy<LoggerService>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.AGENT_WEBHOOK_URL = 'http://localhost:18789/hooks/hub-wake';
    process.env.AGENT_WEBHOOK_TOKEN = 'test-token';
    process.env.AGENT_WEBHOOK_ENABLED = 'true';
    delete process.env.AGENT_WEBHOOK_MIN_URGENCY;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentNotifyService, { provide: LoggerService, useValue: mock<LoggerService>() }],
    }).compile();

    service = module.get<AgentNotifyService>(AgentNotifyService);
    logger = module.get(LoggerService);
  });

  afterEach(() => {
    process.env.AGENT_WEBHOOK_URL = originalEnv.AGENT_WEBHOOK_URL;
    process.env.AGENT_WEBHOOK_TOKEN = originalEnv.AGENT_WEBHOOK_TOKEN;
    process.env.AGENT_WEBHOOK_ENABLED = originalEnv.AGENT_WEBHOOK_ENABLED;
    delete process.env.AGENT_WEBHOOK_MIN_URGENCY;
    vi.restoreAllMocks();
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('notify', () => {
    // The native hook accepts text and timing mode, not the retired plugin envelope.
    it('POSTs the native wake payload: { text, mode: "now" }', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(fetch).toHaveBeenCalledWith('http://localhost:18789/hooks/hub-wake', expect.objectContaining({ method: 'POST' }));
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
      expect(Object.keys(body).sort()).toEqual(['mode', 'text']);
      expect(body.text).toContain('app.crashed');
      expect(body.text).toContain('test:ci-store');
      // `now` avoids waiting for the next scheduled heartbeat.
      expect(body.mode).toBe('now');
    });

    // OpenClaw reads `Authorization` before `X-OpenClaw-Token`. Matching values keep
    // authentication consistent through either the setup proxy or the gateway.
    it('sends the wake secret in X-OpenClaw-Token', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers['X-OpenClaw-Token']).toBe('test-token');
    });

    it('sends the SAME secret in Authorization: Bearer, which OpenClaw reads first', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
      // Mismatched values fail because the bearer token takes precedence.
      expect(headers.Authorization).toBe(`Bearer ${headers['X-OpenClaw-Token']}`);
    });

    // Queued system events survive a 429, so throttling warrants a warning rather than an error.
    it('treats a 429 as throttling, not failure', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '7' } }));

      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'));
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should be a no-op when no targets and AGENT_WEBHOOK_URL is not set', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      await service.notify('test', {}, 'low');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should be a no-op when AGENT_WEBHOOK_ENABLED is false', async () => {
      process.env.AGENT_WEBHOOK_ENABLED = 'false';
      await service.notify('test', {}, 'low');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should not throw when disabled', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      await expect(service.notify('test', {}, 'low')).resolves.toBeUndefined();
    });

    it('should log error when webhook POST fails with network error', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
      await service.notify('test', {}, 'low');
      expect(logger.error).toHaveBeenCalled();
    });

    it('should log error when webhook POST returns non-2xx status', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Server Error', { status: 500 }));
      await service.notify('test', {}, 'low');
      expect(logger.error).toHaveBeenCalled();
    });

    it('should not throw when webhook POST fails', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network failure'));
      await expect(service.notify('test', {}, 'low')).resolves.toBeUndefined();
    });

    it('should debounce identical events within 30-second window', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should not debounce events with different appUrn', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:app1' }, 'high');
      await service.notify('app.crashed', { appUrn: 'ci-store:app2' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should not debounce events with different event names', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');
      await service.notify('app.update_failed', { appUrn: 'test:ci-store' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should send event again after debounce window expires', async () => {
      service._setDebounceWindowMs(0);
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  // Routine info events do not justify a full agent turn.
  describe('urgency floor', () => {
    it.each(['high', 'medium', 'low'] as const)('wakes the agent for %s', async (urgency) => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, urgency);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['update_success', { appUrn: 'test:ci-store' }],
      ['system.mcp_ready', { toolCount: 12 }],
    ])('does not wake the agent for the info-tier event %s', async (event, data) => {
      await service.notify(event, data, 'info');
      expect(fetch).not.toHaveBeenCalled();
    });

    // The environment override must affect filtering at runtime.
    it('honours AGENT_WEBHOOK_MIN_URGENCY', async () => {
      process.env.AGENT_WEBHOOK_MIN_URGENCY = 'high';

      await service.notify('system.high_memory', { usagePercent: 92 }, 'medium');
      expect(fetch).not.toHaveBeenCalled();

      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('lets an operator opt back into the info tier', async () => {
      process.env.AGENT_WEBHOOK_MIN_URGENCY = 'info';
      await service.notify('update_success', { appUrn: 'test:ci-store' }, 'info');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    // Invalid configuration must not suppress every wake.
    it('falls back to the default on an unrecognized value, and says so', async () => {
      process.env.AGENT_WEBHOOK_MIN_URGENCY = 'urgent';

      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AGENT_WEBHOOK_MIN_URGENCY'));
    });

    // Inherited keys such as `constructor` must fail validation; accepting one makes the
    // tier comparison `NaN` and suppresses every wake.
    it('rejects an inherited Object.prototype key as a floor', async () => {
      process.env.AGENT_WEBHOOK_MIN_URGENCY = 'constructor';

      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AGENT_WEBHOOK_MIN_URGENCY'));
    });
  });

  // Startup must restore the in-memory registry so wakes survive Hub restarts.
  describe('rehydration on startup', () => {
    const APPS = [
      { appName: 'openclaw', appStoreSlug: 'ci-store' },
      { appName: 'hermes', appStoreSlug: 'ci-store' },
      { appName: 'immich', appStoreSlug: 'ci-store' }, // no agent — must be skipped
    ];

    const bootWith = async (resolve: (appUrn: string) => Promise<{ url: string; token?: string } | null>) => {
      vi.spyOn(service, 'resolveWebhookTarget').mockImplementation(resolve);
      vi.spyOn(service as unknown as { moduleRef: { get: (t: unknown, o: unknown) => unknown } }, 'moduleRef', 'get').mockReturnValue({
        get: () => ({ getApps: async () => APPS }),
      });
      await service.onApplicationBootstrap();
    };

    it('registers only the apps that actually run an agent', async () => {
      await bootWith(async (appUrn) => (appUrn.includes('immich') ? null : { url: `http://${appUrn}:18789/hooks/wake`, token: `${appUrn}-secret` }));

      const webhooks = service.getRegisteredWebhooks();
      expect(webhooks).toHaveLength(2);
      expect(webhooks.map((w) => w.appUrn).sort()).toEqual(['hermes:ci-store', 'openclaw:ci-store']);
      expect(webhooks[0]?.token).toContain('secret');
    });

    it('skips an unreadable app instead of losing the rest', async () => {
      await bootWith(async (appUrn) => {
        if (appUrn.includes('hermes')) throw new Error('config.json is missing');
        return { url: `http://${appUrn}:18789/hooks/wake`, token: 's' };
      });

      expect(service.getRegisteredWebhooks()).toHaveLength(2); // openclaw + immich
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hermes'));
    });

    it('is idempotent across two boots', async () => {
      const resolve = async (appUrn: string) => ({ url: `http://${appUrn}:18789/hooks/wake`, token: 's' });
      await bootWith(resolve);
      await bootWith(resolve);
      expect(service.getRegisteredWebhooks()).toHaveLength(3);
    });
  });

  // Rewrite the persisted plugin path so existing apps use the native hook without an
  // app update (CI-Hub#897).
  describe('resolveWebhookTarget: legacy endpoint migration', () => {
    // Parse fixtures through the production schema because it supplies the legacy endpoint
    // default. Bypassing that default concealed the no-wake gate regression (CI-Hub#897).
    // Optional Compose JSON exercises Docker service-name resolution.
    const withAppInfo = (hubIntegration: Record<string, unknown>, composeContent: unknown = null) => {
      vi.spyOn(service as unknown as { moduleRef: { get: (t: unknown, o: unknown) => unknown } }, 'moduleRef', 'get').mockReturnValue({
        get: (token: { name?: string }) =>
          token?.name === 'EnvUtils'
            ? { envStringToMap: () => new Map([['HUB_WAKE_SECRET', 'app-secret']]) }
            : {
                getInstalledAppInfo: async () => ({ port: 18789, hub_integration: hubIntegrationSchema.parse(hubIntegration) }),
                getDockerComposeJson: async () => ({ content: composeContent }),
                getAppEnv: async () => ({ content: '' }),
              },
      });
    };

    it('rewrites the dead /hooks/hub-wake path to OpenClaw native /hooks/wake', async () => {
      withAppInfo({ mcp_client: true, wake_endpoint: '/hooks/hub-wake', wake_port: 18789 });

      const target = await service.resolveWebhookTarget('openclaw:ci-store');

      expect(target?.url).toBe('http://openclaw:18789/hooks/wake');
      expect(target?.token).toBe('app-secret');
    });

    it('defaults to /hooks/wake when the manifest names no endpoint', async () => {
      withAppInfo({ mcp_client: true, wake_port: 18789 });

      const target = await service.resolveWebhookTarget('openclaw:ci-store');

      expect(target?.url).toBe('http://openclaw:18789/hooks/wake');
    });

    it('still honours a genuinely custom endpoint', async () => {
      withAppInfo({ mcp_client: true, wake_endpoint: '/custom/wake', wake_port: 9000 });

      const target = await service.resolveWebhookTarget('openclaw:ci-store');

      expect(target?.url).toBe('http://openclaw:9000/custom/wake');
    });

    // MCP tool consumption does not imply wake support. Because the schema supplies the
    // legacy endpoint by default, the gate must treat that value as undeclared (CI-Hub#897).
    it('does not register an MCP-tool consumer that declares no wake endpoint (CI-Hermes)', async () => {
      withAppInfo({ mcp_client: true, sse_events: false, memory: { url_env: 'CI_SERVER_URL' } });

      expect(await service.resolveWebhookTarget('hermes:ci-store')).toBeNull();
    });

    // Docker DNS resolves the Compose service name, which intentionally differs from
    // `appName` in this fixture.
    it('resolves the Docker host from the main compose service, not the appName', async () => {
      // Production returns parsed JSON rather than a serialized Compose document.
      withAppInfo(
        { mcp_client: true, wake_endpoint: '/hooks/wake', wake_port: 18789 },
        {
          schemaVersion: 2,
          services: [
            { name: 'openclaw-db', image: 'postgres:16', isMain: false },
            { name: 'openclaw-app', image: 'nginx:latest', isMain: true },
          ],
        },
      );

      const target = await service.resolveWebhookTarget('openclaw:ci-store');

      expect(target?.url).toBe('http://openclaw-app:18789/hooks/wake');
    });

    it('returns null for an app that runs no agent', async () => {
      withAppInfo({ mcp_client: false });

      expect(await service.resolveWebhookTarget('immich:ci-store')).toBeNull();
    });
  });

  describe('R-MW: Multi-webhook registry', () => {
    it('R-MW-2: should register a webhook for an app', () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'secret-1');

      const webhooks = service.getRegisteredWebhooks();
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0]).toEqual({
        url: 'http://openclaw-ci-store:3000/hooks/hub-wake',
        token: 'secret-1',
        appUrn: 'ci-store:openclaw',
      });
    });

    it('R-MW-2: should unregister a webhook', () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'secret-1');
      const removed = service.unregisterWebhook('ci-store:openclaw');

      expect(removed).toBe(true);
      expect(service.getRegisteredWebhooks()).toHaveLength(0);
    });

    it('R-MW-2: unregisterWebhook returns false for unknown app', () => {
      const removed = service.unregisterWebhook('ci-store:nonexistent');
      expect(removed).toBe(false);
    });

    it('R-MW-3: should fan-out to env webhook AND registered webhook', async () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'oc-secret');

      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(fetch).toHaveBeenCalledTimes(2);

      const urls = vi.mocked(fetch).mock.calls.map((c) => c[0]);
      expect(urls).toContain('http://localhost:18789/hooks/hub-wake');
      expect(urls).toContain('http://openclaw-ci-store:3000/hooks/hub-wake');
    });

    it('R-MW-3: registered webhook uses its own token', async () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'oc-secret');

      await service.notify('test.event', {}, 'low');

      const calls = vi.mocked(fetch).mock.calls;
      const registeredCall = calls.find((c) => (c[0] as string).includes('openclaw'));
      const headers = registeredCall?.[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer oc-secret');
    });

    it('R-MW-4: should use env webhook as fallback when no registered webhooks', async () => {
      await service.notify('test', {}, 'low');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('http://localhost:18789/hooks/hub-wake', expect.anything());
    });

    it('R-MW-4: env webhook and registered webhooks coexist', async () => {
      service.registerWebhook('ci-store:hermes', 'http://hermes-ci-store:8080/wake', 'h-secret');

      await service.notify('test', {}, 'low');

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    // On collisions, use the per-app secret and send once because the global fallback may
    // be stale.
    it('R-MW-4: on a URL collision the registered per-app token wins, and fires once', async () => {
      process.env.AGENT_WEBHOOK_URL = 'http://openclaw:18789/hooks/wake';
      process.env.AGENT_WEBHOOK_TOKEN = 'stale-global-token';
      service.registerWebhook('ci-store:openclaw', 'http://openclaw:18789/hooks/wake', 'correct-app-secret');

      await service.notify('test', {}, 'low');

      expect(fetch).toHaveBeenCalledTimes(1);
      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers['X-OpenClaw-Token']).toBe('correct-app-secret');
      expect(headers.Authorization).toBe('Bearer correct-app-secret');
    });

    it('R-MW-3: should notify via registered webhooks when no env webhook', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'secret');

      await service.notify('test', {}, 'low');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('http://openclaw-ci-store:3000/hooks/hub-wake', expect.anything());
    });

    it('R-MW-3: should continue notifying other targets if one fails', async () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw:3000/wake', 'secret');

      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Network error');
        return new Response('OK', { status: 200 });
      });

      await service.notify('test', {}, 'low');

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should support multiple registered webhooks', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      service.registerWebhook('ci-store:openclaw', 'http://openclaw:3000/wake', 's1');
      service.registerWebhook('ci-store:hermes', 'http://hermes:8080/wake', 's2');
      service.registerWebhook('ci-store:picoclaw', 'http://picoclaw:4000/wake', 's3');

      await service.notify('test', {}, 'low');

      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('should replace webhook on re-register for same appUrn', () => {
      service.registerWebhook('ci-store:openclaw', 'http://old:3000/wake', 'old-secret');
      service.registerWebhook('ci-store:openclaw', 'http://new:3000/wake', 'new-secret');

      const webhooks = service.getRegisteredWebhooks();
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0]?.url).toBe('http://new:3000/wake');
      expect(webhooks[0]?.token).toBe('new-secret');
    });
  });

  describe('wakeApp', () => {
    it('POSTs only to the named app with the job id', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      service.registerWebhook('ci-openclaw:ci-marketplace', 'http://openclaw:18789/hooks/wake', 's');
      service.registerWebhook('ci-hermes:ci-marketplace', 'http://hermes:18790/hooks/wake', 'h');

      const ok = await service.wakeApp('ci-openclaw:ci-marketplace', { jobId: 'job-1' });

      expect(ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('http://openclaw:18789/hooks/wake', expect.objectContaining({ method: 'POST' }));
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
      expect(body.mode).toBe('now');
      expect(body.text).toContain('job-1');
    });
  });
});
