import { apiFetch } from '@/lib/api-fetch';

/**
 * Error-reporting consent for the browser/desktop web bundle.
 *
 * The bundle's DSN is baked in at build time and cannot be revoked afterwards,
 * so the "Allow error monitoring" switch and the `CI_TELEMETRY` /
 * `CI_LOCAL_ONLY` kill switches only reach the frontend if it asks. It asks
 * `GET /api/config/telemetry` — unauthenticated, returns `{ enabled, reason }`,
 * never a DSN — which is the same contract CI-Server, Companion-Planning,
 * CI-Spellbook and CI-Spatial-Companion-WebXR serve.
 *
 * Fails CLOSED. Until a successful answer arrives, and after any failed
 * refresh, `isTelemetryAllowed()` is false and `beforeSend` drops events. The
 * bundle is served by the Hub itself, so an unreachable API means the app is
 * broken anyway — and reporting against a consent decision we could not read is
 * the worse failure.
 */

/** `null` = not yet known. Never treated as permission. */
let allowed: boolean | null = null;
let inFlight: Promise<boolean> | null = null;
let lastResolvedAt = 0;

/** Refresh at most this often when driven from the `beforeSend` hot path. */
export const CONSENT_REFRESH_INTERVAL_MS = 60_000;

/** The gate consulted by `beforeSend`. Unknown consent is not consent. */
export function isTelemetryAllowed(): boolean {
  return allowed === true;
}

/**
 * Notified whenever the answer CHANGES.
 *
 * `beforeSend` can consult {@link isTelemetryAllowed} per event, but Session
 * Replay cannot: replay envelopes never pass through `beforeSend`, so the only
 * way to honour a withdrawal is to stop the recorder itself. That needs an
 * edge, not a poll.
 */
type ConsentListener = (allowed: boolean | null) => void;

const listeners = new Set<ConsentListener>();

export function onTelemetryConsentChange(listener: ConsentListener): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** Test seam / immediate publish when a fresher answer is already in hand. */
export function setTelemetryAllowed(value: boolean | null, now: number = Date.now()): void {
  const changed = allowed !== value;
  allowed = value;
  lastResolvedAt = value === null ? 0 : now;

  if (!changed) {
    return;
  }

  for (const listener of listeners) {
    // One listener throwing must not stop the others from learning that consent
    // was withdrawn — that is the direction where failing quietly leaks data.
    try {
      listener(value);
    } catch {
      // ignored on purpose
    }
  }
}

export function resetTelemetryConsent(): void {
  const changed = allowed !== null;
  allowed = null;
  inFlight = null;
  lastResolvedAt = 0;

  if (changed) {
    for (const listener of listeners) {
      try {
        listener(null);
      } catch {
        // ignored on purpose
      }
    }
  }
}

/** Test seam: drop every subscriber. */
export function resetTelemetryConsentListeners(): void {
  listeners.clear();
}

/**
 * Ask the Hub whether reporting is permitted. Concurrent callers share one
 * request. Any failure — network, non-2xx, unparseable body, a body without a
 * literal `enabled: true` — resolves to `false`.
 */
export function refreshTelemetryConsent(): Promise<boolean> {
  if (inFlight) {
    return inFlight;
  }

  inFlight = apiFetch('/api/config/telemetry', {
    headers: { accept: 'application/json' },
  })
    .then(async (response): Promise<{ answered: boolean; enabled: boolean }> => {
      if (!response.ok) {
        return { answered: false, enabled: false };
      }

      const payload = (await response.json()) as { enabled?: unknown };

      // Anything that is not the documented contract counts as no answer.
      return typeof payload.enabled === 'boolean' ? { answered: true, enabled: payload.enabled } : { answered: false, enabled: false };
    })
    .catch(() => ({ answered: false, enabled: false }))
    .then(({ answered, enabled }) => {
      // A failed read leaves consent UNKNOWN rather than recording a `false`
      // answer: still closed, but the next event retries immediately instead of
      // waiting out the refresh interval. That matters in the desktop shell,
      // where the very first fetch can precede the API base URL being
      // configured.
      setTelemetryAllowed(answered ? enabled : null);
      return answered && enabled;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Kick off a refresh if the cached answer is stale, without blocking the
 * caller. Called from `beforeSend`, so an out-of-band change (another browser
 * tab, an operator editing settings.json) still lands within one interval — the
 * in-app settings save publishes its result immediately and does not wait for
 * this.
 */
export function refreshTelemetryConsentIfStale(now: number = Date.now()): void {
  if (inFlight || now - lastResolvedAt < CONSENT_REFRESH_INTERVAL_MS) {
    return;
  }

  void refreshTelemetryConsent();
}
