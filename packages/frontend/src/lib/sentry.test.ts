import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MutableImportMetaEnv = {
  -readonly [K in keyof ImportMetaEnv]: ImportMetaEnv[K];
};

const testEnv = import.meta.env as MutableImportMetaEnv;

const {
  fetchDeviceRegistrationInfoResult,
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

vi.mock('@sentry/react', () => ({
  captureMessage,
  captureException,
  init,
  setTag,
  setUser,
  withScope,
  browserTracingIntegration,
  replayIntegration,
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
    // `init` silently disables production tracing.
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: [{ name: 'BrowserTracing' }],
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

    expect(init).toHaveBeenCalledWith(expect.objectContaining({ sendDefaultPii: false }));
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
});
