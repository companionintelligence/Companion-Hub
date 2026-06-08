import * as Sentry from '@sentry/react';

let sentryInitialized = false;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function initHubSentry(): void {
  if (sentryInitialized) {
    return;
  }
  if (!isTauri()) {
    return;
  }

  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.CI_HUB_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    enabled: true,
    tracesSampleRate: 0,
    sendDefaultPii: true,
  });

  sentryInitialized = true;
  Sentry.setTag('component', 'desktop-web');
}

initHubSentry();

export function captureHubException(error: unknown, context?: Record<string, unknown>): void {
  if (!isTauri()) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag('component', 'desktop-web');
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined) {
          scope.setExtra(key, value);
        }
      }
    }
    Sentry.captureException(error);
  });
}

export { Sentry };
