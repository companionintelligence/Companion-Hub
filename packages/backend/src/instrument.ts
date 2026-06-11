import * as Sentry from '@sentry/nestjs';
import { scrubEvent } from './core/error-reporting/sentry-scrubber';

const dsn = process.env.SENTRY_DSN?.trim();
const deviceId = process.env.DEVICE_ID?.trim();

// The backend owns its own process-level uncaughtException/unhandledRejection
// handlers (see main.ts) which log, capture, flush, and control exit. Drop
// Sentry's default OnUncaughtException/OnUnhandledRejection integrations so
// crashes are captured exactly once and our handlers govern the exit/flush.
const MANUALLY_HANDLED_INTEGRATIONS = new Set(['OnUncaughtException', 'OnUnhandledRejection']);

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
  }
}
