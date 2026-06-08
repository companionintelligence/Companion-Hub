import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MutableImportMetaEnv = {
  -readonly [K in keyof ImportMetaEnv]: ImportMetaEnv[K];
};

const testEnv = import.meta.env as MutableImportMetaEnv;

const { captureException, init, setTag, setExtra, withScope } = vi.hoisted(() => ({
  captureException: vi.fn(),
  init: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('@sentry/react', () => ({
  captureException,
  init,
  setTag,
  withScope,
}));

describe('frontend sentry', () => {
  const originalEnv = {
    CI_HUB_ENVIRONMENT: import.meta.env.CI_HUB_ENVIRONMENT,
    VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
    VITE_SENTRY_RELEASE: import.meta.env.VITE_SENTRY_RELEASE,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    withScope.mockImplementation((callback: (scope: { setTag: typeof setTag; setExtra: typeof setExtra }) => void) => {
      callback({ setTag, setExtra });
    });
    testEnv.CI_HUB_ENVIRONMENT = 'development';
    testEnv.VITE_SENTRY_DSN = 'https://frontend@example.ingest.sentry.io/123456';
    testEnv.VITE_SENTRY_RELEASE = 'ci-hub-frontend@test';
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    testEnv.CI_HUB_ENVIRONMENT = originalEnv.CI_HUB_ENVIRONMENT;
    testEnv.VITE_SENTRY_DSN = originalEnv.VITE_SENTRY_DSN;
    testEnv.VITE_SENTRY_RELEASE = originalEnv.VITE_SENTRY_RELEASE;
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
    expect(setTag).toHaveBeenCalledWith('component', 'browser-web');
  });

  it('tags Tauri errors as desktop-web', async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};

    const { captureHubException } = await import('./sentry');

    captureHubException(new Error('boom'), { surface: 'test' });

    expect(withScope).toHaveBeenCalledTimes(1);
    expect(setTag).toHaveBeenCalledWith('component', 'desktop-web');
    expect(setExtra).toHaveBeenCalledWith('surface', 'test');
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });
});
