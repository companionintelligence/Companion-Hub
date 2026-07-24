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
    // The target is OpenClaw's NATIVE wake hook, which takes { text, mode } — not the
    // { event, data, urgency, timestamp } envelope the old (404ing) plugin route expected.
    it('POSTs the native wake payload: { text, mode: "now" }', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(fetch).toHaveBeenCalledWith('http://localhost:18789/hooks/hub-wake', expect.objectContaining({ method: 'POST' }));
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
      expect(Object.keys(body).sort()).toEqual(['mode', 'text']);
      expect(body.text).toContain('app.crashed');
      expect(body.text).toContain('test:ci-store');
      // "next-heartbeat" would defer the turn to the next scheduled slot — up to 30 minutes.
      expect(body.mode).toBe('now');
    });

    // The secret goes in BOTH headers, carrying the same value.
    //
    // OpenClaw's extractHookToken reads `Authorization: Bearer` first and returns as soon as it
    // finds a non-empty token — it never falls back to X-OpenClaw-Token. So Authorization is
    // not a harmless extra; whatever lands in it decides the request. Sending the same secret
    // in both means the wake authenticates whichever way it is routed: through CI-OpenClaw's
    // setup-server proxy, or straight to a gateway. Verified on core-2.
    it('sends the wake secret in X-OpenClaw-Token', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers['X-OpenClaw-Token']).toBe('test-token');
    });

    it('sends the SAME secret in Authorization: Bearer, which OpenClaw reads first', async () => {
      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
      // The two must never disagree: Bearer wins, so a mismatch would 401 while looking correct.
      expect(headers.Authorization).toBe(`Bearer ${headers['X-OpenClaw-Token']}`);
    });

    // OpenClaw sheds load with 429 + Retry-After. Nothing is lost — the system events it
    // already queued still reach the next heartbeat — so this is a warning, not an error.
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

  // Every wake costs a full agent turn, so the routine `info` tier (update_success,
  // system.mcp_ready) is dropped: it tells the user nothing they did not already expect.
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

    // The floor is a real, settable knob — not decorative config. It sits alongside the
    // module's existing AGENT_WEBHOOK_* env vars.
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

    // A typo must not silently mute every wake — the failure mode would be invisible.
    it('falls back to the default on an unrecognized value, and says so', async () => {
      process.env.AGENT_WEBHOOK_MIN_URGENCY = 'urgent';

      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AGENT_WEBHOOK_MIN_URGENCY'));
    });

    // ...and a value that an `in` check would have waved through. "constructor" is a key on
    // Object.prototype, so `'constructor' in URGENCY_TIERS` is true; the floor then compares as
    // NaN and drops EVERY wake, silently. Validation is Object.hasOwn for exactly this reason.
    it('rejects an inherited Object.prototype key as a floor', async () => {
      process.env.AGENT_WEBHOOK_MIN_URGENCY = 'constructor';

      await service.notify('app.crashed', { appUrn: 'test:ci-store' }, 'high');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AGENT_WEBHOOK_MIN_URGENCY'));
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
    // The mock feeds hub_integration through the REAL hubIntegrationSchema, because that is what
    // getInstalledAppInfo does in production — and the schema back-fills wake_endpoint with its
    // Zod .default('/hooks/hub-wake'). A raw hand-built object skips that default and makes the
    // Hermes case look absent when production sees the legacy path; that divergence is exactly how
    // the dead-gate bug (CI-Hub#897) hid behind a green test. `composeContent` defaults to null
    // (service name falls back to the URN's appName); pass real compose JSON to exercise the
    // service-name branch that is otherwise never executed.
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

    // The real CI-Hermes manifest: `mcp_client: true`, and no wake endpoint or port anywhere.
    // It consumes Hub MCP tools; it is not an agent and serves no hook. Gating on mcp_client
    // alone would register it and fan every Hub event into a 404 — on every boot, now that the
    // registry is rehydrated. The two capabilities are not the same set.
    //
    // This only bites in production because the schema defaults wake_endpoint to the legacy path,
    // so the gate cannot test for its absence — it must treat the legacy default as "not declared".
    // The mock now applies that same default (via hubIntegrationSchema.parse), so reverting the
    // gate to a plain `!wake_endpoint` check makes THIS test fail, where before it stayed green.
    it('does not register an MCP-tool consumer that declares no wake endpoint (CI-Hermes)', async () => {
      withAppInfo({ mcp_client: true, sse_events: false, memory: { url_env: 'CI_SERVER_URL' } });

      expect(await service.resolveWebhookTarget('hermes:ci-store')).toBeNull();
    });

    // The host is the compose SERVICE name, not the URN's appName — that is the entire reason
    // resolveWebhookTarget parses docker-compose. Every other fixture stubs compose to null, so
    // this branch is otherwise never executed and a regression to the wrong host (every wake 404s)
    // would not be caught. Here the main service is named `openclaw-app`, deliberately unequal to
    // the appName `openclaw`, so the assertion can only pass if the service name is actually used.
    it('resolves the Docker host from the main compose service, not the appName', async () => {
      // getDockerComposeJson returns already-parsed JSON (readJsonFile), so `content` is an
      // object, not a string — pass it as one, the way parseComposeJson receives it in production.
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

    // When AGENT_WEBHOOK_URL names the same URL a registered app already owns, the app's own
    // secret must win — it is authoritative for that URL, whereas the env token is a single
    // global fallback that may be stale. Sending the stale env token would 401 an otherwise-good
    // wake, and sending both would POST the same URL twice.
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
});
