import * as Sentry from '@sentry/nestjs';
import { DEFAULT_DEV_CI_CLOUD_URL, DEFAULT_PROD_CI_CLOUD_URL } from './common/constants';
import { scrubEvent } from './core/error-reporting/sentry-scrubber';
import { envTelemetryBlock, isReportingAllowed } from './core/error-reporting/telemetry-consent';

const dsn = process.env.SENTRY_DSN?.trim();
const deviceId = process.env.DEVICE_ID?.trim();
const portalUrl = normalizePortalUrl(process.env.CI_CLOUD_URL);
const deploymentVersion = process.env.CI_HUB_VERSION?.trim();
const hubImage = process.env.CI_HUB_IMAGE?.trim();

function sampleRate(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

// The backend owns its own process-level uncaughtException/unhandledRejection
// handlers (see main.ts) which log, capture, flush, and control exit. Drop
// Sentry's default OnUncaughtException/OnUnhandledRejection integrations so
// crashes are captured exactly once and our handlers govern the exit/flush.
//
// ContextLines is dropped for a different reason: it attaches seven lines of
// real source around every in-app frame, and a runtime probe showed that
// scrubbing that text is not sufficient. `scrubString` can only catch home
// paths and *prefixed* credentials (`api_key=…`); a bare IP, an email, or an
// opaque key literal sitting in a nearby source line matches nothing and ships
// verbatim. That makes it an unbounded channel whose contents depend on
// whatever happens to be written near a throw. The stack frames, line numbers
// and release SHA remain, and the source for a given release is a lookup away,
// so triage loses very little for a leak class that cannot otherwise be closed.
const MANUALLY_HANDLED_INTEGRATIONS = new Set(['OnUncaughtException', 'OnUnhandledRejection', 'ContextLines']);

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

/** Extract `:tag` from an image ref like `ghcr.io/org/ci-hub:v0.2.5` (not digests). */
function hubImageTag(image: string): string | null {
  // Only inspect the final path segment so `localhost:5000/ci-hub:tag` works and
  // `repo@sha256:…` digests are ignored.
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

/**
 * The `beforeSend` consent gate.
 *
 * Evaluated per event rather than once at init, so flipping "Allow error
 * monitoring" in Settings stops (or resumes) reporting on the very next capture
 * without restarting the Hub. Returning `null` drops the event before the
 * transport ever sees it.
 */
function gateAndScrub(event: Parameters<typeof scrubEvent>[0], hint: Parameters<typeof scrubEvent>[1]): ReturnType<typeof scrubEvent> {
  if (!isReportingAllowed(process.env)) {
    return null;
  }

  return scrubEvent(event, hint);
}

// `CI_LOCAL_ONLY` / `CI_TELEMETRY` are process-lifetime env switches, so an
// opted-out process should never construct a transport at all. The *user's*
// switch is deliberately not consulted here — gating it in `beforeSend` instead
// is what lets a mid-session flip work in both directions.
if (dsn && !envTelemetryBlock(process.env)) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? process.env.CI_HUB_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE ?? process.env.CI_HUB_VERSION,
    enabled: true,
    tracesSampleRate: sampleRate('SENTRY_TRACES_SAMPLE_RATE', 0.1),
    // Sentry 11 removed the `enableMetrics` option; dropping every metric here
    // keeps the `SENTRY_ENABLE_METRICS=false` opt-out working.
    beforeSendMetric: (metric) => (process.env.SENTRY_ENABLE_METRICS === 'false' ? null : metric),
    // Likewise `enableLogs` is gone in Sentry 11; keep `SENTRY_ENABLE_LOGS=false` working.
    beforeSendLog: (log) => (process.env.SENTRY_ENABLE_LOGS === 'false' ? null : log),
    // The rest of the fleet sends no PII, and the Sentry org has
    // `scrubIPAddresses` disabled — leaving the SDK defaults on made the Hub the
    // one component storing users' real IP addresses. Sentry 11 replaced
    // `sendDefaultPii` with `dataCollection`, whose defaults collect
    // *everything*, so every category is switched off explicitly to keep the old
    // `sendDefaultPii: false` posture. `user.id` — our `device_id` — is set
    // explicitly below and is unaffected by `userInfo`, so triage loses nothing.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // Without this, @sentry/node-core resolves `serverName` to `os.hostname()`
    // and the runtime stamps it on every event inside `_prepareEvent` — i.e.
    // before `beforeSend` — regardless of `dataCollection`. Personal machines
    // are routinely named after their owner, which is precisely the identifier
    // the `device_id` tag exists to replace. `scrubEvent` deletes the field too;
    // this stops it ever being computed.
    includeServerName: false,
    integrations: (defaults) => defaults.filter((integration) => !MANUALLY_HANDLED_INTEGRATIONS.has(integration.name)),
    beforeSend: gateAndScrub,
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

  // Full compose image ref + tag so release triage can filter by container version
  // even when Sentry `release` is a git SHA bake.
  if (hubImage) {
    Sentry.setTag('hub_image', hubImage);
    const imageTag = hubImageTag(hubImage);
    if (imageTag) {
      Sentry.setTag('hub_image_tag', imageTag);
    }
  }
}
