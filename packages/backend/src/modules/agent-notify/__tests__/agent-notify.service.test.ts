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
    vi.restoreAllMocks();
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('notify', () => {
    // The target is OpenClaw's NATIVE wake hook, which takes { text, mode } — not the
    // { event, data, urgency, timestamp } envelope the old (404ing) plugin route expected.
    it('POSTs the native wake payload: { text, mode: "now" }', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');

      expect(fetch).toHaveBeenCalledWith('http://localhost:18789/hooks/hub-wake', expect.objectContaining({ method: 'POST' }));
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
      expect(Object.keys(body).sort()).toEqual(['mode', 'text']);
      expect(body.text).toContain('app.crashed');
      expect(body.text).toContain('ci-store:test');
      // "next-heartbeat" would defer the turn to the next scheduled slot — up to 30 minutes.
      expect(body.mode).toBe('now');
    });

    // REGRESSION (CI-OpenClaw server.cjs:312): the Hub POSTs to the app's published port,
    // which is CI-OpenClaw's setup server. That proxy OVERWRITES Authorization with the
    // gateway token before forwarding, so a wake authenticated on Authorization alone can
    // never arrive. The secret has to travel in a header the proxy does not touch.
    it('sends the secret in X-OpenClaw-Token, which survives the CI-OpenClaw proxy', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');

      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers['X-OpenClaw-Token']).toBe('test-token');
    });

    // Still sent, for a caller that reaches an OpenClaw gateway directly (no proxy in front).
    it('also sends Authorization: Bearer for direct-to-gateway callers', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');

      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
    });

    // OpenClaw sheds load with 429 + Retry-After. Nothing is lost — the system events it
    // already queued still reach the next heartbeat — so this is a warning, not an error.
    it('treats a 429 as throttling, not failure', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '7' } }));

      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');

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
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should not debounce events with different appUrn', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:app1' }, 'high');
      await service.notify('app.crashed', { appUrn: 'ci-store:app2' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should not debounce events with different event names', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      await service.notify('app.update_failed', { appUrn: 'ci-store:test' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should send event again after debounce window expires', async () => {
      service._setDebounceWindowMs(0);
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  // Every wake costs a full agent turn, so the routine `info` tier (update_success,
  // system.mcp_ready) is dropped: it tells the user nothing they did not already expect.
  describe('urgency floor', () => {
    it.each(['high', 'medium', 'low'] as const)('wakes the agent for %s', async (urgency) => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, urgency);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['update_success', { appUrn: 'ci-store:test' }],
      ['system.mcp_ready', { toolCount: 12 }],
    ])('does not wake the agent for the info-tier event %s', async (event, data) => {
      await service.notify(event, data, 'info');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // The registry is in-memory, and until now it was only ever populated by the install
  // path. So every Hub restart silently emptied it: an app installed yesterday received no
  // wakes today, and nothing said why. This is the fix, and the reason wake could not have
  // been verified working for more than one Hub lifetime.
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

  // Every app installed to date has `wake_endpoint: "/hooks/hub-wake"` frozen into its
  // on-disk config.json — a path the ci-hub plugin never managed to serve. Honouring it
  // would keep those apps POSTing into a 404 until someone bumped the marketplace manifest
  // AND ran an app update. Rewriting it means wake works on the next Hub restart instead,
  // and the manifest/image rollout order stops being load-bearing.
  describe('resolveWebhookTarget: legacy endpoint migration', () => {
    const withAppInfo = (hubIntegration: Record<string, unknown>) => {
      vi.spyOn(service as unknown as { moduleRef: { get: (t: unknown, o: unknown) => unknown } }, 'moduleRef', 'get').mockReturnValue({
        get: (token: { name?: string }) =>
          token?.name === 'EnvUtils'
            ? { envStringToMap: () => new Map([['HUB_WAKE_SECRET', 'app-secret']]) }
            : {
                getInstalledAppInfo: async () => ({ port: 18789, hub_integration: hubIntegration }),
                getDockerComposeJson: async () => ({ content: null }),
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

      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');

      // Should call both env webhook and registered webhook
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
});
