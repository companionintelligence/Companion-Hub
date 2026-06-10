import * as Sentry from '@sentry/react';
import { apiFetch } from './api-fetch';

let sentryInitialized = false;
let deviceIdRequest: Promise<void> | null = null;

const SENTRY_DEVICE_ID_STORAGE_KEY = 'ci-hub-sentry-device-id';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function getComponentTag(): 'browser-web' | 'desktop-web' {
  return isTauri() ? 'desktop-web' : 'browser-web';
}

function normalizeDeviceId(deviceId: string | null | undefined): string | null {
  const normalized = deviceId?.trim();
  return normalized ? normalized : null;
}

function readStoredDeviceId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return normalizeDeviceId(sessionStorage.getItem(SENTRY_DEVICE_ID_STORAGE_KEY));
}

function applyDeviceId(deviceId: string | null | undefined): void {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) {
    return;
  }

  if (typeof window !== 'undefined') {
    sessionStorage.setItem(SENTRY_DEVICE_ID_STORAGE_KEY, normalized);
  }

  if (!sentryInitialized) {
    return;
  }

  Sentry.setTag('device_id', normalized);
}

async function ensureHubSentryDeviceId(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  if (readStoredDeviceId()) {
    applyDeviceId(readStoredDeviceId());
    return;
  }

  if (deviceIdRequest) {
    return deviceIdRequest;
  }

  deviceIdRequest = apiFetch('/api/registration/device-id')
    .then(async (response) => {
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { device_id?: string };
      applyDeviceId(payload.device_id);
    })
    .catch((error: unknown) => {
      if (import.meta.env.DEV) {
        console.warn('Failed to load Sentry device ID', error);
      }
    })
    .finally(() => {
      deviceIdRequest = null;
    });

  return deviceIdRequest;
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
  applyDeviceId(readStoredDeviceId());
  void ensureHubSentryDeviceId();
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
  void ensureHubSentryDeviceId();

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

export function setHubSentryDeviceId(deviceId: string | null | undefined): void {
  initHubSentry();
  applyDeviceId(deviceId);
}

export function loadHubSentryDeviceId(): Promise<void> {
  initHubSentry();
  if (!sentryInitialized) {
    return Promise.resolve();
  }
  return ensureHubSentryDeviceId();
}

export { Sentry };
