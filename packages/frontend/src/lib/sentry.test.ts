import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_REFRESH_INTERVAL_MS } from './telemetry-consent';

type MutableImportMetaEnv = {
  -readonly [K in keyof ImportMetaEnv]: ImportMetaEnv[K];
};

const testEnv = import.meta.env as MutableImportMetaEnv;

const {
  fetchDeviceRegistrationInfoResult,
  addBreadcrumb,
  captureException,
  captureMessage,
  init,
  setLevel,
  setTag,
  setExtra,
  setUser,
  withScope,
  browserTracingIntegration,
  replayIntegration,
} = vi.hoisted(() => ({
  fetchDeviceRegistrationInfoResult: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
  setUser: vi.fn(),
  withScope: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
}));

const { consoleIntegration, makeFetchTransport, transportSend } = vi.hoisted(() => {
  const transportSend = vi.fn(async () => ({ statusCode: 200 }));

  return {
    transportSend,
    consoleIntegration: vi.fn((options: object) => ({ name: 'Console', ...options })),
    makeFetchTransport: vi.fn(() => ({ send: transportSend, flush: vi.fn(async () => true) })),
  };
});

vi.mock('@sentry/react', () => ({
  addBreadcrumb,
  captureMessage,
  captureException,
  init,
  setTag,
  setUser,
  withScope,
  browserTracingIntegration,
  replayIntegration,
  consoleIntegration,
  makeFetchTransport,
}));

vi.mock('./registration-api', () => ({
  fetchDeviceRegistrationInfoResult,
}));

// The consent gate has its own suite (telemetry-consent.test.ts); stub it here
// so these tests exercise enrichment/noise-dropping deterministically instead of
// racing the real `/api/config/telemetry` fetch that init kicks off.
const { telemetryAllowed, refreshTelemetryConsent, refreshTelemetryConsentIfStale, onTelemetryConsentChange } = vi.hoisted(() => ({
  telemetryAllowed: { value: true },
  refreshTelemetryConsent: vi.fn(async () => true),
  refreshTelemetryConsentIfStale: vi.fn(),
  // Session Replay subscribes to consent changes at init; replay's own gating
  // is covered by session-replay-consent.test.ts.
  onTelemetryConsentChange: vi.fn(() => () => {}),
}));

vi.mock('./telemetry-consent', () => ({
  CONSENT_REFRESH_INTERVAL_MS: 60_000,
  isTelemetryAllowed: () => telemetryAllowed.value,
  refreshTelemetryConsent,
  refreshTelemetryConsentIfStale,
  onTelemetryConsentChange,
}));

describe('frontend sentry', () => {
  const originalEnv = {
    DEV: import.meta.env.DEV,
    CI_CLOUD_URL: import.meta.env.CI_CLOUD_URL,
    CI_HUB_VERSION: import.meta.env.CI_HUB_VERSION,
    CI_HUB_IMAGE: import.meta.env.CI_HUB_IMAGE,
    CI_HUB_ENVIRONMENT: import.meta.env.CI_HUB_ENVIRONMENT,
    VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
    VITE_SENTRY_RELEASE: import.meta.env.VITE_SENTRY_RELEASE,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    withScope.mockImplementation((callback: (scope: { setTag: typeof setTag; setExtra: typeof setExtra; setLevel: typeof setLevel }) => void) => {
      callback({ setTag, setExtra, setLevel });
    });
    // Vitest runs with import.meta.env.DEV=true; production-path tests need init enabled.
    testEnv.DEV = false;
    testEnv.CI_CLOUD_URL = 'https://hub.ci.computer/';
    testEnv.CI_HUB_VERSION = 'v0.2.27';
    testEnv.CI_HUB_IMAGE = 'ghcr.io/companionintelligence/ci-hub:v0.2.27';
    testEnv.CI_HUB_ENVIRONMENT = 'development';
    testEnv.VITE_SENTRY_DSN = 'https://frontend@example.ingest.sentry.io/123456';
    testEnv.VITE_SENTRY_RELEASE = 'ci-hub-frontend@test';
    fetchDeviceRegistrationInfoResult.mockImplementation(() => Promise.resolve({ ok: true, status: 200, data: { device_id: 'device-123' } }));
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    telemetryAllowed.value = true;
  });

  afterEach(() => {
    testEnv.DEV = originalEnv.DEV;
    testEnv.CI_CLOUD_URL = originalEnv.CI_CLOUD_URL;
    testEnv.CI_HUB_VERSION = originalEnv.CI_HUB_VERSION;
    testEnv.CI_HUB_IMAGE = originalEnv.CI_HUB_IMAGE;
    testEnv.CI_HUB_ENVIRONMENT = originalEnv.CI_HUB_ENVIRONMENT;
    testEnv.VITE_SENTRY_DSN = originalEnv.VITE_SENTRY_DSN;
    testEnv.VITE_SENTRY_RELEASE = originalEnv.VITE_SENTRY_RELEASE;
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('does not initialize Sentry in Vite dev builds', async () => {
    testEnv.DEV = true;

    await import('./sentry');

    expect(init).not.toHaveBeenCalled();
  });

  it('initializes Sentry for browser users when a frontend DSN is configured', async () => {
    await import('./sentry');

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://frontend@example.ingest.sentry.io/123456',
        environment: 'development',
        release: 'ci-hub-frontend@test',
      }),
    );
    expect(browserTracingIntegration).toHaveBeenCalledOnce();
    // Factories being called is not enough — dropping their return values from
    // `init` silently disables production tracing. The console integration is the
    // same-named replacement that switches off console breadcrumbs.
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: [{ name: 'BrowserTracing' }, { name: 'Console', levels: [] }],
      }),
    );
    /*
     * Replay is deliberately NOT registered at init and is NOT in `integrations`.
     * Registering it here starts recording before consent is known, and replay
     * envelopes never pass through `beforeSend` — so the gate below cannot stop
     * them. It is added on grant instead; see session-replay-consent.test.ts.
     */
    expect(replayIntegration).not.toHaveBeenCalled();
    expect(setTag).toHaveBeenCalledWith('component', 'browser-web');
    expect(setTag).toHaveBeenCalledWith('ci_portal_url', 'https://hub.ci.computer');
    expect(setTag).toHaveBeenCalledWith('ci_portal_environment', 'prod');
    expect(setTag).toHaveBeenCalledWith('deployment_version', 'v0.2.27');
    expect(setTag).toHaveBeenCalledWith('hub_image', 'ghcr.io/companionintelligence/ci-hub:v0.2.27');
    expect(setTag).toHaveBeenCalledWith('hub_image_tag', 'v0.2.27');
    await vi.waitFor(() => expect(setTag).toHaveBeenCalledWith('device_id', 'device-123'));
    expect(setUser).toHaveBeenCalledWith({ id: 'device-123' });
    expect(fetchDeviceRegistrationInfoResult).toHaveBeenCalled();
  }, 30_000);

  it('tags Tauri errors as desktop-web', async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};

    const { captureHubException } = await import('./sentry');

    captureHubException(new Error('boom'), { surface: 'test' });

    expect(withScope).toHaveBeenCalledTimes(1);
    expect(setTag).toHaveBeenCalledWith('component', 'desktop-web');
    expect(setExtra).toHaveBeenCalledWith('surface', 'test');
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'ios-web'],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 'android-web'],
  ])('tags mobile Tauri errors from an %s webview by platform, not desktop-web', async (_name, ua, expectedTag) => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    const originalUa = navigator.userAgent;
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
    try {
      const { captureHubException } = await import('./sentry');
      captureHubException(new Error('boom'), { surface: 'test' });
      expect(setTag).toHaveBeenCalledWith('component', expectedTag);
      expect(setTag).not.toHaveBeenCalledWith('component', 'desktop-web');
    } finally {
      Object.defineProperty(window.navigator, 'userAgent', { value: originalUa, configurable: true });
    }
  });

  it('stores and applies an explicit device id', async () => {
    const { setHubSentryDeviceId } = await import('./sentry');

    setHubSentryDeviceId('device-xyz');

    expect(setTag).toHaveBeenCalledWith('device_id', 'device-xyz');
    expect(setUser).toHaveBeenCalledWith({ id: 'device-xyz' });
    expect(sessionStorage.getItem('ci-hub-sentry-device-id')).toBe('device-xyz');
  });

  it('deduplicates warning captures within the debounce window', async () => {
    const { captureHubWarning } = await import('./sentry');

    captureHubWarning('startup fallback warning', { source: 'test' }, { dedupeKey: 'startup-warning' });
    captureHubWarning('startup fallback warning', { source: 'test' }, { dedupeKey: 'startup-warning' });

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('startup fallback warning', 'warning');
  });

  it('records a breadcrumb without sending an event of its own', async () => {
    const { addHubBreadcrumb } = await import('./sentry');

    addHubBreadcrumb('status temporarily unavailable', { status: 0 });

    expect(addBreadcrumb).toHaveBeenCalledWith({ category: 'hub', level: 'warning', message: 'status temporarily unavailable', data: { status: 0 } });
    expect(captureMessage).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('records no breadcrumb while Sentry is not running', async () => {
    testEnv.DEV = true;
    const { addHubBreadcrumb } = await import('./sentry');

    addHubBreadcrumb('status temporarily unavailable');

    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it('drops known handled frontend noise in beforeSend', async () => {
    await import('./sentry');

    type SentryEventInput = {
      message?: string;
      exception?: { values?: Array<{ value?: string }> };
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
      fingerprint?: string[];
    };
    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as
      | ((event: SentryEventInput, hint?: { originalException?: unknown }) => SentryEventInput | null)
      | undefined;
    expect(beforeSend).toBeTypeOf('function');

    expect(
      beforeSend?.({
        message: 'userContext unavailable during startup; using defaults',
      }),
    ).toBeNull();
    expect(
      beforeSend?.({
        exception: {
          values: [{ value: 'Failed to fetch dynamically imported module: http://localhost/app.js' }],
        },
      }),
    ).toBeNull();
    expect(
      beforeSend?.({
        exception: {
          values: [
            { value: 'window.set_background_color not allowed. Permissions associated with this command: core:window:allow-set-background-color' },
          ],
        },
      }),
    ).toBeNull();
    expect(
      beforeSend?.({
        exception: {
          values: [{ value: 'Command plugin:window|close not allowed by ACL' }],
        },
      }),
    ).toBeNull();
  });

  it('drops fetch failures against the configured local Hub API and keeps the rest', async () => {
    const { client } = await import('@/api-client/client.gen');
    await import('./sentry');

    type SentryEventInput = { exception?: { values?: Array<{ value?: string }> } };
    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as ((event: SentryEventInput) => SentryEventInput | null) | undefined;
    expect(beforeSend).toBeTypeOf('function');
    const failed = (value: string) => ({ exception: { values: [{ value }] } });

    try {
      client.setConfig({ baseUrl: 'http://127.0.0.1:5002' });
      // The SDK records whichever loopback name the request used.
      expect(beforeSend?.(failed('Failed to fetch (localhost:5002)'))).toBeNull();
      expect(beforeSend?.(failed('Load failed (127.0.0.1:5002)'))).toBeNull();
      // Another port or host is not the configured Hub API.
      expect(beforeSend?.(failed('Failed to fetch (127.0.0.1:5004)'))).not.toBeNull();
      expect(beforeSend?.(failed('Failed to fetch (hub.ci.computer)'))).not.toBeNull();
      // Without a host there is no origin to match, so the event is kept.
      expect(beforeSend?.(failed('Failed to fetch'))).not.toBeNull();

      // When the Hub API is on another machine, a failure here is not that Hub.
      client.setConfig({ baseUrl: 'https://hub-home.ci.computer' });
      expect(beforeSend?.(failed('Failed to fetch (localhost:5002)'))).not.toBeNull();
    } finally {
      client.setConfig({ baseUrl: '' });
    }
  });

  it('drops a store load that got no response and an injected automation call, and keeps the rest', async () => {
    await import('./sentry');

    type SentryEventInput = { exception?: { values?: Array<{ value?: string }> } };
    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as ((event: SentryEventInput) => SentryEventInput | null) | undefined;
    expect(beforeSend).toBeTypeOf('function');
    const failed = (value: string) => ({ exception: { values: [{ value }] } });

    // Status 0 means no response reached the app: the device is offline, or the network dropped.
    expect(beforeSend?.(failed('Failed to load store listings (0)'))).toBeNull();
    expect(beforeSend?.(failed('Failed to load alternatives (0): something'))).toBeNull();
    // A status the server did answer with is a real failure and is kept.
    expect(beforeSend?.(failed('Failed to load store listings (503): Service Unavailable'))).not.toBeNull();
    // Only the call an automation script injects is dropped; another missing page function is the app's own.
    expect(beforeSend?.(failed('Function "__seenText" is not exposed'))).toBeNull();
    expect(beforeSend?.(failed('Function "renderPage" is not exposed'))).not.toBeNull();
  });

  it('rewrites TranslatableError events with HTTP status and path, and drops 4xx', async () => {
    const { TranslatableError } = await import('@/types/error.types');
    await import('./sentry');

    type SentryEventInput = {
      message?: string;
      exception?: { values?: Array<{ value?: string }> };
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
      fingerprint?: string[];
    };
    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as
      | ((event: SentryEventInput, hint?: { originalException?: unknown }) => SentryEventInput | null)
      | undefined;

    const clientError = new TranslatableError(
      'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN',
      {},
      {
        status: 401,
        url: 'http://localhost:5005/api/apps',
      },
    );
    expect(beforeSend?.({ exception: { values: [{ value: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN' }] } }, { originalException: clientError })).toBeNull();

    const serverError = new TranslatableError(
      'COMMON_AN_ERROR_OCCURRED',
      {},
      {
        status: 500,
        url: 'http://localhost:5005/api/marketplace/apps/search?pageSize=500',
        body: 'Internal Server Error',
      },
    );
    const enriched = beforeSend?.({ exception: { values: [{ value: 'COMMON_AN_ERROR_OCCURRED' }] } }, { originalException: serverError });

    expect(enriched?.exception?.values?.[0]?.value).toBe('COMMON_AN_ERROR_OCCURRED (500 /api/marketplace/apps/search)');
    expect(enriched?.tags?.http_status).toBe('500');
    expect(enriched?.extra?.response_body).toBe('Internal Server Error');
    // The raw `res.url` kept its query string; the enricher now strips it.
    expect(enriched?.extra?.http_url).toBe('http://localhost:5005/api/marketplace/apps/search');
    expect(enriched?.fingerprint).toEqual(['translatable-api-error', '500', '/api/marketplace/apps/search']);
  });

  it('scrubs the payload in beforeSend before it leaves the browser', async () => {
    await import('./sentry');

    type SentryEventInput = {
      message?: string;
      request?: { url?: string; cookies?: Record<string, string>; data?: unknown; headers?: Record<string, string> };
      extra?: Record<string, unknown>;
    };
    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as
      | ((event: SentryEventInput, hint?: { originalException?: unknown }) => SentryEventInput | null)
      | undefined;

    // httpContextIntegration sets request.url from location.href, and the
    // reset-password route carries a live one-time token in its query string.
    const scrubbed = beforeSend?.({
      message: 'boom at /Users/bennett/devel',
      request: {
        url: 'https://hub.ci.localhost/auth/reset-password?token=one-time-secret',
        cookies: { 'ci-hub-session': 'session-value' },
        data: { password: 'hunter2' },
        headers: { cookie: 'ci-hub-session=session-value', 'User-Agent': 'Mozilla/5.0' },
      },
      extra: { apiKey: 'ci_live_abcdef' },
    });

    expect(scrubbed?.request?.url).toBe('https://hub.ci.localhost/auth/reset-password');
    expect(scrubbed?.request?.cookies).toBeUndefined();
    expect(scrubbed?.request?.data).toBeUndefined();
    expect(scrubbed?.request?.headers?.cookie).toBe('[Filtered]');
    expect(scrubbed?.request?.headers?.['User-Agent']).toBe('Mozilla/5.0');
    expect(scrubbed?.message).toBe('boom at ~/devel');
    expect(scrubbed?.extra?.apiKey).toBe('[Filtered]');
  });

  it('asks the Hub for consent as soon as it initialises', async () => {
    await import('./sentry');

    expect(refreshTelemetryConsent).toHaveBeenCalled();
  });

  it('never sends PII', async () => {
    await import('./sentry');

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dataCollection: expect.objectContaining({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [] }),
      }),
    );
  });

  it('keeps the metrics and logs opt-outs working through the before-send hooks', async () => {
    vi.stubEnv('VITE_SENTRY_ENABLE_METRICS', 'false');
    vi.stubEnv('VITE_SENTRY_ENABLE_LOGS', 'false');
    await import('./sentry');

    const options = init.mock.calls[0]?.[0] as {
      beforeSendMetric: (m: object) => object | null;
      beforeSendLog: (l: object) => object | null;
    };
    expect(options.beforeSendMetric({})).toBeNull();
    expect(options.beforeSendLog({})).toBeNull();

    vi.unstubAllEnvs();
    const metric = {};
    expect(options.beforeSendMetric(metric)).toBe(metric);
  });

  it('drops every event in beforeSend once the user withdraws consent', async () => {
    await import('./sentry');

    type SentryEventInput = { message?: string; exception?: { values?: Array<{ value?: string }> } };
    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as
      | ((event: SentryEventInput, hint?: { originalException?: unknown }) => SentryEventInput | null)
      | undefined;
    expect(beforeSend).toBeTypeOf('function');

    // An ordinary event goes out while consent stands…
    const event = { exception: { values: [{ value: 'a real bug' }] } };
    expect(beforeSend?.(event)).not.toBeNull();

    // …and stops the moment the switch flips, with no re-init and no reload.
    telemetryAllowed.value = false;
    expect(beforeSend?.(event)).toBeNull();

    // …and resumes when it flips back, from the same initialised client.
    telemetryAllowed.value = true;
    expect(beforeSend?.(event)).not.toBeNull();
  });

  it('keeps the consent answer fresh from the beforeSend path', async () => {
    await import('./sentry');

    type SentryEventInput = { exception?: { values?: Array<{ value?: string }> } };
    const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as ((event: SentryEventInput) => SentryEventInput | null) | undefined;

    refreshTelemetryConsentIfStale.mockClear();
    beforeSend?.({ exception: { values: [{ value: 'a real bug' }] } });
    expect(refreshTelemetryConsentIfStale).toHaveBeenCalled();

    telemetryAllowed.value = false;
    refreshTelemetryConsentIfStale.mockClear();
    beforeSend?.({ exception: { values: [{ value: 'a real bug' }] } });
    // Also refreshed on the dropped path, so an opt-in is noticed.
    expect(refreshTelemetryConsentIfStale).toHaveBeenCalled();
  });

  it('switches off console breadcrumbs with the SDK console integration', async () => {
    await import('./sentry');

    // A same-named integration replaces the SDK default, so the levels option is the switch.
    expect(consoleIntegration).toHaveBeenCalledWith({ levels: [] });
  });

  it('sends no trace, session or replay envelope while consent is off', async () => {
    await import('./sentry');

    type TransportLike = { send: (envelope: unknown) => Promise<unknown>; flush: (timeout?: number) => Promise<boolean> };
    const createTransport = init.mock.calls[0]?.[0]?.transport as ((options: object) => TransportLike) | undefined;
    expect(createTransport).toBeTypeOf('function');

    const options = { url: 'https://example.ingest.sentry.io/api/1/envelope/' };
    const transport = createTransport?.(options);
    expect(makeFetchTransport).toHaveBeenCalledWith(options);
    const envelope = [{ event_id: 'abc' }, [[{ type: 'span' }, { items: [] }]]];

    // Span envelopes never reach beforeSend, so the transport is what keeps them in the browser.
    telemetryAllowed.value = false;
    await expect(transport?.send(envelope)).resolves.toEqual({});
    expect(transportSend).not.toHaveBeenCalled();

    telemetryAllowed.value = true;
    await transport?.send(envelope);
    expect(transportSend).toHaveBeenCalledWith(envelope);
  });

  it('scrubs span URLs, identity attributes and secrets before a span is sent', async () => {
    await import('./sentry');

    type SpanLike = { name: string; attributes: Record<string, unknown> };
    const beforeSendSpan = init.mock.calls[0]?.[0]?.beforeSendSpan as ((span: SpanLike) => SpanLike) | undefined;
    expect(beforeSendSpan).toBeTypeOf('function');

    const scrubbed = beforeSendSpan?.({
      name: 'GET /Users/bennett/devel/api',
      attributes: {
        'http.url': 'https://hub.ci.localhost/auth/join?token=one-time-secret',
        'http.target': '/auth/join?token=one-time-secret',
        'http.query': '?token=one-time-secret',
        'user.email': 'bennett@example.com',
        'user.ip_address': '203.0.113.7',
        'http.request.header.authorization': 'Bearer abc123',
        'http.response.status_code': 200,
      },
    });

    expect(scrubbed?.name).toBe('GET ~/devel/api');
    expect(scrubbed?.attributes['http.url']).toBe('https://hub.ci.localhost/auth/join');
    expect(scrubbed?.attributes['http.target']).toBe('/auth/join');
    expect(scrubbed?.attributes['http.query']).toBe('[Filtered]');
    expect(scrubbed?.attributes).not.toHaveProperty('user.email');
    expect(scrubbed?.attributes).not.toHaveProperty('user.ip_address');
    expect(scrubbed?.attributes).not.toHaveProperty('http.request.header.authorization');
    expect(scrubbed?.attributes['http.response.status_code']).toBe(200);
  });

  it('re-asks the Hub for consent on a timer, so a switch flipped elsewhere reaches an idle page', async () => {
    // Only the interval is faked, so the module import itself is not affected.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    try {
      await import('./sentry');
      refreshTelemetryConsent.mockClear();

      vi.advanceTimersByTime(CONSENT_REFRESH_INTERVAL_MS - 1);
      expect(refreshTelemetryConsent).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(refreshTelemetryConsent).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(CONSENT_REFRESH_INTERVAL_MS);
      expect(refreshTelemetryConsent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
