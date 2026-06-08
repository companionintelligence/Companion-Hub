import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();

vi.mock('@sentry/nestjs', () => ({
  init,
}));

describe('backend instrument', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    init.mockReset();
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENV;
    delete process.env.SENTRY_RELEASE;
    delete process.env.CI_HUB_ENVIRONMENT;
    delete process.env.CI_HUB_VERSION;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers CI_HUB_ENVIRONMENT over NODE_ENV for backend sentry environment', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    process.env.CI_HUB_ENVIRONMENT = 'production';
    process.env.NODE_ENV = 'development';
    process.env.CI_HUB_VERSION = '4.7.0';

    await import('../instrument');

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
        environment: 'production',
        release: '4.7.0',
        sendDefaultPii: false,
      }),
    );
  });

  it('does not initialize sentry without a DSN', async () => {
    await import('../instrument');

    expect(init).not.toHaveBeenCalled();
  });
});
