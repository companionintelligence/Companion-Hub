import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();
const setTag = vi.fn();
const setUser = vi.fn();
const transportSend = vi.fn(async () => ({ statusCode: 200 }));
const makeNodeTransport = vi.fn(() => ({ send: transportSend, flush: vi.fn(async () => true) }));
const consoleIntegration = vi.fn((options: object) => ({ name: 'Console', ...options }));

vi.mock('@sentry/nestjs', () => ({
  init,
  setTag,
  setUser,
  makeNodeTransport,
  consoleIntegration,
}));

describe('backend instrument', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    init.mockReset();
    setTag.mockReset();
    transportSend.mockClear();
    consoleIntegration.mockClear();
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENV;
    delete process.env.SENTRY_RELEASE;
    delete process.env.CI_HUB_ENVIRONMENT;
    delete process.env.CI_HUB_VERSION;
    delete process.env.CI_CLOUD_URL;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers CI_HUB_ENVIRONMENT over NODE_ENV for backend sentry environment', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    process.env.CI_HUB_ENVIRONMENT = 'production';
    process.env.NODE_ENV = 'development';
    process.env.CI_HUB_VERSION = 'v0.2.27';
    process.env.CI_CLOUD_URL = 'https://hub.ci.computer/';

    await import('../instrument');

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
        environment: 'production',
        release: 'v0.2.27',
        // No PII. Sentry 11's defaults collect everything, so each category is
        // off explicitly; the Sentry org does not scrub IPs server-side.
        dataCollection: expect.objectContaining({
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
        }),
      }),
    );
    expect(setTag).toHaveBeenCalledWith('ci_portal_url', 'https://hub.ci.computer');
    expect(setTag).toHaveBeenCalledWith('ci_portal_environment', 'prod');
    expect(setTag).toHaveBeenCalledWith('deployment_version', 'v0.2.27');
    expect(setUser).not.toHaveBeenCalled();
  });

  it('keeps the metrics and logs opt-outs working through the before-send hooks', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    process.env.SENTRY_ENABLE_METRICS = 'false';
    process.env.SENTRY_ENABLE_LOGS = 'false';

    await import('../instrument');

    const options = init.mock.calls[0]?.[0] as {
      beforeSendMetric: (m: object) => object | null;
      beforeSendLog: (l: object) => object | null;
    };
    expect(options.beforeSendMetric({})).toBeNull();
    expect(options.beforeSendLog({})).toBeNull();

    delete process.env.SENTRY_ENABLE_METRICS;
    delete process.env.SENTRY_ENABLE_LOGS;
    const metric = {};
    expect(options.beforeSendMetric(metric)).toBe(metric);
  });

  it('does not initialize sentry without a DSN', async () => {
    await import('../instrument');

    expect(init).not.toHaveBeenCalled();
  });

  it('sends no server name and attaches no source context', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

    await import('../instrument');

    const options = init.mock.calls[0]?.[0] as {
      includeServerName?: boolean;
      integrations?: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    };

    // Otherwise the runtime resolves serverName to os.hostname() and stamps it on
    // every event inside _prepareEvent — before beforeSend, and regardless of
    // dataCollection.
    expect(options.includeServerName).toBe(false);

    // ContextLines attaches seven lines of real source per frame. Scrubbing that
    // text is not sufficient — a bare IP, email or opaque key literal in a
    // nearby line matches no pattern — so the integration is dropped outright.
    const kept = options.integrations?.([
      { name: 'ContextLines' },
      { name: 'OnUncaughtException' },
      { name: 'OnUnhandledRejection' },
      { name: 'RequestData' },
      { name: 'Http' },
    ]);

    expect(kept?.map((integration) => integration.name)).toEqual(['RequestData', 'Http']);
  });

  it.each([
    ['CI_LOCAL_ONLY', 'true'],
    ['CI_TELEMETRY', 'off'],
  ])('does not construct a transport when %s=%s', async (key, value) => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    process.env[key] = value;

    await import('../instrument');

    // The env kill switches cannot change without a restart, so an opted-out
    // process never initialises at all rather than dropping events one by one.
    expect(init).not.toHaveBeenCalled();
  });

  it('gates every event on consent in beforeSend, so a flip needs no restart', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

    await import('../instrument');
    const { setUserConsent } = await import('../core/error-reporting/telemetry-consent');

    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as
      | ((event: Record<string, unknown>, hint: Record<string, unknown>) => unknown)
      | undefined;
    expect(beforeSend).toBeTypeOf('function');

    const event = { exception: { values: [{ type: 'Error', value: 'a real bug' }] } };

    setUserConsent(true);
    expect(beforeSend?.(event, {})).not.toBeNull();

    setUserConsent(false);
    expect(beforeSend?.(event, {})).toBeNull();

    setUserConsent(true);
    expect(beforeSend?.(event, {})).not.toBeNull();

    // Unreadable settings fail closed.
    setUserConsent('unreadable');
    expect(beforeSend?.(event, {})).toBeNull();
  });

  it('sends no trace or session envelope while the user switch is off', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

    await import('../instrument');
    const { setUserConsent } = await import('../core/error-reporting/telemetry-consent');

    type TransportFactory = (options: object) => { send: (envelope: unknown) => Promise<unknown> };
    const createTransport = init.mock.calls[0]?.[0]?.transport as TransportFactory | undefined;
    expect(createTransport).toBeTypeOf('function');

    const transport = createTransport?.({ url: 'https://o0.ingest.sentry.io/api/0/envelope/' });
    const envelope = [{ event_id: 'abc' }, [[{ type: 'span' }, { items: [] }]]];

    // Span and session envelopes never reach beforeSend, so the transport is the gate for them.
    setUserConsent(false);
    await expect(transport?.send(envelope)).resolves.toEqual({});
    expect(transportSend).not.toHaveBeenCalled();

    setUserConsent(true);
    await transport?.send(envelope);
    expect(transportSend).toHaveBeenCalledWith(envelope);
  });

  it('scrubs span URLs and identity attributes before a span is sent', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

    await import('../instrument');

    type SpanLike = { name: string; attributes: Record<string, unknown> };
    const beforeSendSpan = init.mock.calls[0]?.[0]?.beforeSendSpan as ((span: SpanLike) => SpanLike) | undefined;
    expect(beforeSendSpan).toBeTypeOf('function');

    const scrubbed = beforeSendSpan?.({
      name: 'GET /Users/bennett/api',
      attributes: {
        'url.full': 'https://hub.ci.localhost/api/join?token=one-time-secret',
        'url.query': '?token=one-time-secret',
        'user.email': 'bennett@example.com',
        'http.response.status_code': 200,
      },
    });

    expect(scrubbed?.name).toBe('GET ~/api');
    expect(scrubbed?.attributes['url.full']).toBe('https://hub.ci.localhost/api/join');
    expect(scrubbed?.attributes['url.query']).toBe('[Filtered]');
    expect(scrubbed?.attributes).not.toHaveProperty('user.email');
    expect(scrubbed?.attributes['http.response.status_code']).toBe(200);
  });

  it('switches off console breadcrumbs with the SDK console integration', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

    await import('../instrument');

    const options = init.mock.calls[0]?.[0] as { integrations?: (defaults: Array<{ name: string }>) => Array<{ name: string }> };
    const kept = options.integrations?.([{ name: 'Console' }, { name: 'Http' }]);

    // The Console default is replaced by one that captures no levels; the other defaults pass through.
    expect(consoleIntegration).toHaveBeenCalledWith({ levels: [] });
    expect(kept?.map((integration) => integration.name)).toEqual(['Console', 'Http']);
  });
});
