import * as Sentry from '@sentry/react';
import { TranslatableError } from '@/types/error.types';
import { isChunkLoadError } from './chunk-load-error';
import { fetchDeviceRegistrationInfoResult } from './registration-api';
import { scrubBreadcrumb, scrubBrowserEvent, scrubString, scrubUrl } from './sentry-scrubber';
import { isTelemetryAllowed, refreshTelemetryConsent, refreshTelemetryConsentIfStale } from './telemetry-consent';

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

function getComponentTag(): 'browser-web' | 'desktop-web' | 'ios-web' | 'android-web' {
  if (!isTauri()) return 'browser-web';
  // Same UA detection as mobile-connection.ts detectMobileSync() — without it,
  // every mobile Tauri event would be mislabeled 'desktop-web'.
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios-web';
  if (/android/i.test(ua)) return 'android-web';
  return 'desktop-web';
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

function getHubImage(): string | null {
  const image = import.meta.env.CI_HUB_IMAGE?.trim();
  return image ? image : null;
}

/** Extract `:tag` from an image ref like `ghcr.io/org/ci-hub:v0.2.5` (not digests). */
function hubImageTag(image: string): string | null {
  const name = image.includes('/') ? image.slice(image.lastIndexOf('/') + 1) : image;
  if (name.includes('@')) {
    return null;
  }
  const colon = name.lastIndexOf(':');
  if (colon === -1) {
    return null;
  }
  const tag = name.slice(colon + 1).trim();
  return tag || null;
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

  const hubImage = getHubImage();
  if (hubImage) {
    Sentry.setTag('hub_image', hubImage);
    const imageTag = hubImageTag(hubImage);
    if (imageTag) {
      Sentry.setTag('hub_image_tag', imageTag);
    }
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

  deviceIdRequest = fetchDeviceRegistrationInfoResult()
    .then((result) => {
      if (!result.ok) {
        return;
      }

      const payload = (result.data ?? {}) as { device_id?: string };
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

function apiPathForSentry(url: string): string {
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
    return parsed.pathname || url;
  } catch {
    return url;
  }
}

/**
 * Rewrite a TranslatableError event so Sentry shows the failing HTTP request
 * (status + path + body snippet) instead of only the generic i18n key.
 * Client errors (4xx) are expected UI feedback and are dropped.
 */
function enrichTranslatableErrorEvent(event: Sentry.ErrorEvent, error: TranslatableError): Sentry.ErrorEvent | null {
  if (!error.http) {
    return event;
  }

  if (error.http.status >= 400 && error.http.status < 500) {
    return null;
  }

  const path = apiPathForSentry(error.http.url);
  const summary = `${error.message} (${error.http.status} ${path})`;
  const values = event.exception?.values;
  if (values?.[0]) {
    values[0].value = summary;
  } else {
    event.message = summary;
  }

  event.tags = {
    ...event.tags,
    http_status: String(error.http.status),
  };
  event.extra = {
    ...event.extra,
    http_status: error.http.status,
    // The raw `res.url` captured in root.tsx keeps its query string, which on
    // this app carries app slugs, pairing codes and search terms. `path` above
    // was already query-stripped for the title and fingerprint; attaching the
    // unstripped URL right beside it gave that back.
    http_url: scrubUrl(error.http.url),
    http_path: path,
    // The first 300 characters of the failing response. Kept — it is the single
    // most useful field for triaging a 5xx — but run through the scrubber,
    // since it is server output we do not control.
    response_body: typeof error.http.body === 'string' ? scrubString(error.http.body) : error.http.body,
    message_key: error.message,
  };
  event.fingerprint = ['translatable-api-error', String(error.http.status), path];

  return event;
}

function shouldDropSentryEvent(event: Sentry.ErrorEvent): boolean {
  const exceptionValues = event.exception?.values ?? [];
  const haystack = [event.message, ...exceptionValues.flatMap((value) => [value.value, value.type])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  for (const text of haystack) {
    if (isChunkLoadError(text) || isChunkLoadError(new TypeError(text))) {
      return true;
    }
    if (text.includes('set_background_color not allowed')) {
      return true;
    }
    // Tauri ACL denials for remote hub URLs / missing capabilities — expected until
    // the desktop shell allowlists the origin; not actionable frontend bugs.
    if (text.includes('not allowed by ACL')) {
      return true;
    }
    if (text === 'userContext unavailable during startup; using defaults') {
      return true;
    }
    // TanStack Query throws CancelledError whenever an in-flight query is
    // superseded or unmounted; it is expected control flow, not a failure.
    if (text === 'CancelledError') {
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

  // Local dev sessions (vite dev server / HMR) previously flooded the
  // production Sentry project with CancelledError, HMR, and localhost API
  // failures. Dev builds keep console reporting only.
  if (import.meta.env.DEV) {
    return;
  }

  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  // Initialise eagerly and gate in `beforeSend`, rather than awaiting consent
  // before init: that way a mid-session flip of "Allow error monitoring" takes
  // effect on the next capture in BOTH directions, with no reload. Nothing is
  // sent until the consent fetch below resolves — `isTelemetryAllowed()` is
  // false while the answer is unknown.
  void refreshTelemetryConsent();

  Sentry.init({
    dsn,
    environment: import.meta.env.CI_HUB_ENVIRONMENT || import.meta.env.MODE,
    release: getSentryRelease(),
    enabled: true,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })],
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    replaysSessionSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE ?? 0.1),
    replaysOnErrorSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE ?? 1),
    enableMetrics: import.meta.env.VITE_SENTRY_ENABLE_METRICS !== 'false',
    enableLogs: import.meta.env.VITE_SENTRY_ENABLE_LOGS !== 'false',
    // No PII, matching the rest of the fleet. The Sentry org has
    // `scrubIPAddresses` disabled, so leaving this on meant the Hub was the one
    // component storing users' real IP addresses. Device attribution comes from
    // the explicit `device_id` tag/user id set below, not from the SDK.
    sendDefaultPii: false,
    beforeSend(event, hint) {
      if (!isTelemetryAllowed()) {
        // Keep the cached answer fresh for subsequent events; an in-app settings
        // save publishes its result immediately and does not wait for this.
        refreshTelemetryConsentIfStale();
        return null;
      }

      refreshTelemetryConsentIfStale();

      if (shouldDropSentryEvent(event)) {
        return null;
      }

      const original = hint?.originalException;
      // Enrich first, scrub second: the enricher adds extras of its own, and
      // scrubbing before that would leave them unredacted.
      const enriched = original instanceof TranslatableError ? enrichTranslatableErrorEvent(event, original) : event;

      return enriched === null ? null : scrubBrowserEvent(enriched);
    },
    // Breadcrumbs are attached to the event by the SDK and scrubbed above too;
    // doing it here as well means a crumb is redacted at the moment it is
    // recorded, so it cannot leak via any other path that reads the buffer.
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
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
    if (error instanceof TranslatableError && error.http) {
      const path = apiPathForSentry(error.http.url);
      scope.setTag('http_status', String(error.http.status));
      scope.setExtra('http_status', error.http.status);
      // Same reasoning as enrichTranslatableErrorEvent: the raw URL carries a
      // query string the query-stripped `path` deliberately drops.
      scope.setExtra('http_url', scrubUrl(error.http.url));
      scope.setExtra('http_path', path);
      scope.setExtra('response_body', typeof error.http.body === 'string' ? scrubString(error.http.body) : error.http.body);
      scope.setExtra('message_key', error.message);
      scope.setFingerprint(['translatable-api-error', String(error.http.status), path]);
    }
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
