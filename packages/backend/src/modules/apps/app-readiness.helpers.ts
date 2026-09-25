/**
 * The Hub's view of an app-declared readiness endpoint (`hub_integration.readiness`,
 * CI-Hub#1556), normalised away from any one app's body shape so a second agent app can map
 * onto the same fields. This is a second axis next to app status, never an input to it:
 * status stays what Docker says (`app-status-sync.service.ts`).
 */
export type AppReadinessStatus = 'ok' | 'degraded' | 'unknown';

export type AppReadinessCheck = {
  /** The app's own vocabulary, passed through (`ok`, `degraded`, `unavailable`, ...); only `ok` is read as fine. */
  status: string;
  detail?: string;
};

export type AppReadiness = {
  /**
   * `unknown` covers every way the Hub can fail to know: the probe timed out or errored, the
   * app answered non-2xx, or the body carried nothing readable. It is deliberately never
   * `degraded`, because a single missed probe on a cold gateway is not a broken app.
   */
  status: AppReadinessStatus;
  /** Per-subsystem checks by name, as the app reports them; empty when the body had none. */
  checks: Record<string, AppReadinessCheck>;
  /** A turn is in flight. `null` when the app does not say. */
  busy: boolean | null;
  /** Safe to restart right now. `null` when the app does not say. */
  drainable: boolean | null;
  sampledAt: string;
};

const READINESS_STATUSES: ReadonlySet<string> = new Set<AppReadinessStatus>(['ok', 'degraded']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** What a probe that produced nothing readable reports — see {@link AppReadiness.status}. */
export function unknownReadiness(sampledAt: string): AppReadiness {
  return { status: 'unknown', checks: {}, busy: null, drainable: null, sampledAt };
}

/**
 * Reduces a readiness endpoint's JSON body to {@link AppReadiness}. Pure, and tolerant of
 * garbage: anything it cannot read becomes `unknown` rather than a throw, because this runs
 * inside the runtime monitor's tick and a malformed answer from one app must not cost the
 * others their sample.
 *
 * Reads the shape Hermes's `/health/detailed` serves — `readiness.status`,
 * `readiness.checks[name].{status,detail}`, `gateway_busy`, `gateway_drainable` — but only
 * those keys: each check's other fields (`used_percent`, `connected_platforms`, ...) are
 * app-specific and dropped. A body with no `readiness` block (a bare `/health`) is `ok` only
 * when it says `status: "ok"` at the top level; it reports no checks either way.
 *
 * Overall status is taken from the body, not derived from the checks, and only the two
 * words it can mean are accepted: any other value is `unknown`, because guessing `degraded`
 * from a status this build does not know (a future `starting`, say) would raise a false
 * alarm on a healthy app. The non-ok checks still come through, so the page can show them.
 */
export function normalizeReadinessBody(body: unknown, sampledAt: string): AppReadiness {
  if (!isRecord(body)) {
    return unknownReadiness(sampledAt);
  }

  const busy = booleanOrNull(body.gateway_busy);
  const drainable = booleanOrNull(body.gateway_drainable);

  const readiness = body.readiness;
  if (!isRecord(readiness)) {
    return { status: body.status === 'ok' ? 'ok' : 'unknown', checks: {}, busy, drainable, sampledAt };
  }

  const status: AppReadinessStatus =
    typeof readiness.status === 'string' && READINESS_STATUSES.has(readiness.status) ? (readiness.status as AppReadinessStatus) : 'unknown';

  const checks: Record<string, AppReadinessCheck> = {};
  if (isRecord(readiness.checks)) {
    for (const [name, check] of Object.entries(readiness.checks)) {
      if (!isRecord(check) || typeof check.status !== 'string') {
        continue;
      }
      const detail = typeof check.detail === 'string' && check.detail.trim() ? check.detail : undefined;
      checks[name] = detail === undefined ? { status: check.status } : { status: check.status, detail };
    }
  }

  return { status, checks, busy, drainable, sampledAt };
}
