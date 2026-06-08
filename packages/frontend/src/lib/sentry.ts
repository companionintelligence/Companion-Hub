import * as Sentry from '@sentry/react';

let sentryInitialized = false;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function getComponentTag(): 'browser-web' | 'desktop-web' {
  return isTauri() ? 'desktop-web' : 'browser-web';
}

export function initHubSentry(): void {
  if (sentryInitialized) {
    return;
  }
  if (typeof window === 'undefined') {
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
  Sentry.setTag('component', getComponentTag());
}

initHubSentry();

export function captureHubException(error: unknown, context?: Record<string, unknown>): void {
  if (typeof window === 'undefined') {
    return;
  }
  initHubSentry();
  if (!sentryInitialized) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag('component', getComponentTag());
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
