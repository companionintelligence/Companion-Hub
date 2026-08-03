import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();
const setTag = vi.fn();
const setUser = vi.fn();

vi.mock('@sentry/nestjs', () => ({
  init,
  setTag,
  setUser,
}));

describe('backend instrument', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    init.mockReset();
    setTag.mockReset();
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
        // No PII. This flag governs `user.ip_address` and the IP-bearing request
        // headers, and the Sentry org does not scrub IPs server-side.
        sendDefaultPii: false,
      }),
    );
    expect(setTag).toHaveBeenCalledWith('ci_portal_url', 'https://hub.ci.computer');
    expect(setTag).toHaveBeenCalledWith('ci_portal_environment', 'prod');
    expect(setTag).toHaveBeenCalledWith('deployment_version', 'v0.2.27');
    expect(setUser).not.toHaveBeenCalled();
  });

  it('does not initialize sentry without a DSN', async () => {
    await import('../instrument');

    expect(init).not.toHaveBeenCalled();
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
});
