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
        sendDefaultPii: true,
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
});
