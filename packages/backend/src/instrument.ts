import * as Sentry from '@sentry/nestjs';
import { scrubEvent } from './core/error-reporting/sentry-scrubber';

const dsn = process.env.SENTRY_DSN?.trim();

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE ?? process.env.CI_HUB_VERSION,
    enabled: true,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });
}
