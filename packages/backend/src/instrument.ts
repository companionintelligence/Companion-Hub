import * as Sentry from '@sentry/nestjs';
import { DEFAULT_DEV_CI_CLOUD_URL, DEFAULT_PROD_CI_CLOUD_URL } from './common/constants';
import { scrubEvent } from './core/error-reporting/sentry-scrubber';

const dsn = process.env.SENTRY_DSN?.trim();
const deviceId = process.env.DEVICE_ID?.trim();
const portalUrl = normalizePortalUrl(process.env.CI_CLOUD_URL);
const deploymentVersion = process.env.CI_HUB_VERSION?.trim();

// The backend owns its own process-level uncaughtException/unhandledRejection
// handlers (see main.ts) which log, capture, flush, and control exit. Drop
// Sentry's default OnUncaughtException/OnUnhandledRejection integrations so
// crashes are captured exactly once and our handlers govern the exit/flush.
const MANUALLY_HANDLED_INTEGRATIONS = new Set(['OnUncaughtException', 'OnUnhandledRejection']);

function normalizePortalUrl(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/, '');
  return normalized ? normalized : null;
}

function resolvePortalEnvironment(url: string): 'dev' | 'prod' | 'custom' {
  if (url === DEFAULT_DEV_CI_CLOUD_URL) {
    return 'dev';
  }
  if (url === DEFAULT_PROD_CI_CLOUD_URL) {
    return 'prod';
  }
  return 'custom';
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? process.env.CI_HUB_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE ?? process.env.CI_HUB_VERSION,
    enabled: true,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    sendDefaultPii: true,
    integrations: (defaults) => defaults.filter((integration) => !MANUALLY_HANDLED_INTEGRATIONS.has(integration.name)),
    beforeSend: scrubEvent,
  });

  if (deviceId) {
    Sentry.setTag('device_id', deviceId);
    Sentry.setUser({ id: deviceId });
  }

  if (portalUrl) {
    Sentry.setTag('ci_portal_url', portalUrl);
    Sentry.setTag('ci_portal_environment', resolvePortalEnvironment(portalUrl));
  }

  if (deploymentVersion) {
    Sentry.setTag('deployment_version', deploymentVersion);
  }
}
