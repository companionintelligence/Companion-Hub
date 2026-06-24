import * as Sentry from '@sentry/react';
import { isChunkLoadError } from './chunk-load-error';
import { apiFetch } from './api-fetch';

let sentryInitialized = false;
let deviceIdRequest: Promise<void> | null = null;
const warningDebounce = new Map<string, number>();

const DEFAULT_DEV_PORTAL_URL = 'https://hub.companionintelligence.com';
const DEFAULT_PROD_PORTAL_URL = 'https://hub.ci.computer';
const SENTRY_DEVICE_ID_STORAGE_KEY = 'ci-hub-sentry-device-id';
const WARNING_DEBOUNCE_MS = 60_000;

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

function normalizePortalUrl(url: string | null | undefined): string | null {
  const normalized = url?.trim().replace(/\/+$/, '');
  return normalized ? normalized : null;
}

function getPortalUrl(): string {
  return (
    normalizePortalUrl(import.meta.env.CI_CLOUD_URL as string | undefined) ||
    (import.meta.env.CI_HUB_ENVIRONMENT === 'production' ? DEFAULT_PROD_PORTAL_URL : DEFAULT_DEV_PORTAL_URL)
  );
}

function getPortalEnvironment(url: string): 'dev' | 'prod' | 'custom' {
  if (url === DEFAULT_DEV_PORTAL_URL) {
    return 'dev';
  }
  if (url === DEFAULT_PROD_PORTAL_URL) {
    return 'prod';
  }
  return 'custom';
}

function getDeploymentVersion(): string | null {
  const version = import.meta.env.CI_HUB_VERSION?.trim();
  return version ? version : null;
}

function getSentryRelease(): string | undefined {
  const release = import.meta.env.VITE_SENTRY_RELEASE?.trim();
  if (release) {
    return release;
  }

  const deploymentVersion = getDeploymentVersion();
  return deploymentVersion ? `ci-hub-frontend@${deploymentVersion}` : undefined;
}

function applyStaticSentryTags(): void {
  if (!sentryInitialized) {
    return;
  }

  const portalUrl = getPortalUrl();
  Sentry.setTag('ci_portal_url', portalUrl);
  Sentry.setTag('ci_portal_environment', getPortalEnvironment(portalUrl));

  const deploymentVersion = getDeploymentVersion();
  if (deploymentVersion) {
    Sentry.setTag('deployment_version', deploymentVersion);
  }
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
  Sentry.setUser({ id: normalized });
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

function shouldDropSentryEvent(event: Sentry.ErrorEvent): boolean {
  const haystack = [event.message, ...(event.exception?.values?.map((value) => value.value) ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  for (const text of haystack) {
    if (isChunkLoadError(text) || isChunkLoadError(new TypeError(text))) {
      return true;
    }
    if (text.includes('set_background_color not allowed')) {
      return true;
    }
    if (text === 'userContext unavailable during startup; using defaults') {
      return true;
    }
  }

  return false;
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
    release: getSentryRelease(),
    enabled: true,
    tracesSampleRate: 0,
    sendDefaultPii: true,
    beforeSend(event) {
      return shouldDropSentryEvent(event) ? null : event;
    },
  });

  sentryInitialized = true;
  Sentry.setTag('component', getComponentTag());
  applyStaticSentryTags();
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

export function captureHubWarning(message: string, context?: Record<string, unknown>, options?: { dedupeKey?: string; debounceMs?: number }): void {
  if (typeof window === 'undefined') {
    return;
  }

  initHubSentry();
  if (!sentryInitialized) {
    return;
  }
  void ensureHubSentryDeviceId();

  const dedupeKey = options?.dedupeKey ?? message;
  const debounceMs = options?.debounceMs ?? WARNING_DEBOUNCE_MS;
  const now = Date.now();
  const lastSent = warningDebounce.get(dedupeKey);
  if (lastSent !== undefined && now - lastSent < debounceMs) {
    return;
  }
  warningDebounce.set(dedupeKey, now);

  Sentry.withScope((scope) => {
    scope.setTag('component', getComponentTag());
    scope.setLevel('warning');
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined) {
          scope.setExtra(key, value);
        }
      }
    }
    Sentry.captureMessage(message, 'warning');
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
