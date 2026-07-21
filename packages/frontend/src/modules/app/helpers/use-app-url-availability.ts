import { checkAvailabilityOptions, resolveAvailabilityMutation } from '@/api-client/@tanstack/react-query.gen';
import type { AppStatus } from '@/types/app.types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/**
 * Shared readiness state for an app's PUBLIC ROUTE (the tunnel/DNS address the
 * Open button hands to the browser), kept deliberately separate from container
 * runtime health.
 *
 * The two are genuinely different facts — a freshly started app can have every
 * container up (healthy, "Running") while Cloudflare has not finished
 * publishing its hostname — and the UI used to compute them in two places that
 * then disagreed on screen: a green "Running" pill next to a "Starting…"
 * launch button. This hook is the single source of truth so the status pill and
 * the launch action can never contradict each other again.
 *
 * Owned by the app-detail pages (like `runtimeHealth`) and passed down to both
 * `AppStatus` and `AppActions`, so there is exactly one poll loop and one grace
 * clock per page.
 */

/** Probe stages returned by `GET /api/apps/:urn/check-availability`. */
export type AppUrlProbeStage = 'ready' | 'propagating' | 'error';

/**
 * Shape of the check-availability payload. The endpoint has no NestJS DTO, so
 * the generated client types it `unknown` — narrow it here rather than sprinkle
 * casts across the consumers.
 */
export interface AppUrlProbeResult {
  available: boolean;
  appUrl?: string;
  httpStatus?: number;
  stage?: AppUrlProbeStage;
  reason?: string;
  detail?: string;
  errorCode?: string;
  resolvable?: boolean;
}

/**
 * Coarse lifecycle of the public route.
 *
 * - `idle` — nothing to probe (app not running, headless, or local-only access).
 * - `checking` — no verdict yet; show a neutral spinner, never an error.
 * - `ready` — the URL answered; the app can be opened.
 * - `propagating` — transient: the route is still coming up (DNS/tunnel).
 * - `unreachable` — a settled failure, or we stopped probing.
 */
export type AppPublicUrlState = 'idle' | 'checking' | 'ready' | 'propagating' | 'unreachable';

export interface AppUrlAvailability {
  state: AppPublicUrlState;
  /** Resolved public URL, as soon as the backend can derive one (even while unavailable). */
  appUrl: string | null;
  /** Already-translated explanation ("DNS propagating..."); null when ready/idle. */
  statusMessage: string | null;
  /** Raw backend error code, kept for callers that branch on a specific failure. */
  errorCode: string | null;
  /** The backend believes a `resolve` attempt could fix this. */
  resolvable: boolean;
  /** Early window in which a not-yet-available route is expected, not a fault. */
  withinGracePeriod: boolean;
  /** We gave up probing; the UI should offer a manual retry instead of a spinner. */
  pollingStopped: boolean;
  isResolving: boolean;
  /** Ask the backend to repair the route (re-sync DNS/tunnel), then re-probe. */
  resolve: () => void;
  /** Restart probing from scratch — fresh grace window, fresh give-up budget. */
  reset: () => void;
}

/** Probe attempts inside this window are the "expected to still be coming up" phase. */
const GRACE_PERIOD_MS = 60_000;
/** Poll cadence inside the grace window — the route usually lands in seconds. */
const GRACE_POLL_MS = 3_000;
/** Slower cadence afterwards; by now something is likely wrong, so stop hammering. */
const NORMAL_POLL_MS = 10_000;
/** Total probing budget. Past this an abandoned tab must not poll forever. */
const MAX_POLL_MS = 5 * 60_000;

/**
 * Backend error codes → i18n keys for the short, user-facing explanation. Codes
 * with no entry fall back to the backend's own English `detail` string.
 */
const PROBE_MESSAGE_KEYS: Record<string, string> = {
  CF_TUNNEL_NOT_FOUND: 'APP_ACTION_ERROR_CF_TUNNEL_NOT_FOUND',
  CF_UPSTREAM_ERROR: 'APP_ACTION_ERROR_CF_UPSTREAM_ERROR',
  CF_ORIGIN_DOWN: 'APP_ACTION_ERROR_CF_ORIGIN_DOWN',
  CF_TIMEOUT: 'COMMON_CONNECTION_TIMED_OUT',
  CF_UNKNOWN: 'APP_ACTION_ERROR_CF_UNKNOWN',
  DNS_NOT_FOUND: 'APP_ACTION_ERROR_DNS_NOT_FOUND',
  CONNECTION_REFUSED: 'APP_ACTION_ERROR_CONNECTION_REFUSED',
  CONNECTION_TIMEOUT: 'COMMON_CONNECTION_TIMED_OUT',
  PROXY_UPSTREAM_ERROR: 'APP_ACTION_ERROR_PROXY_UPSTREAM_ERROR',
  APP_HTTP_ERROR: 'APP_ACTION_ERROR_APP_HTTP_ERROR',
  NO_DEVICE_REGISTRATION: 'APP_ACTION_ERROR_NO_DEVICE_REGISTRATION',
};

/**
 * Translation key for a probe error code, or null when the code is unknown (the
 * caller then shows the backend's raw detail). Exported for tests.
 */
export function resolveProbeMessageKey(errorCode: string | null | undefined): string | null {
  if (!errorCode) {
    return null;
  }

  return PROBE_MESSAGE_KEYS[errorCode] ?? null;
}

/**
 * Delay before the next probe, or null when probing should stop — because the
 * route is serving, or because the budget is spent and an abandoned tab must
 * not keep polling. Split out as a pure function so the cadence is testable
 * without driving a live query. Exported for tests.
 */
export function nextProbeDelayMs(input: { available: boolean; graceElapsed: boolean; pollingStopped: boolean }): number | null {
  if (input.available || input.pollingStopped) {
    return null;
  }

  return input.graceElapsed ? NORMAL_POLL_MS : GRACE_POLL_MS;
}

/**
 * Collapse the raw probe signals into one state. Precedence is load-bearing:
 * a disabled probe is `idle` (never a failure); no verdict yet is `checking`,
 * which is also where a failed *request* lands — a broken Hub call says nothing
 * about the app, so it must not read as "unreachable"; success wins over
 * everything else; and an exhausted budget is `unreachable` even if the last
 * verdict said "propagating", because we have stopped watching it come up.
 * Exported for tests.
 */
export function derivePublicUrlState(input: {
  enabled: boolean;
  hasVerdict: boolean;
  available: boolean;
  stage: AppUrlProbeStage | null;
  pollingStopped: boolean;
}): AppPublicUrlState {
  if (!input.enabled) {
    return 'idle';
  }

  if (!input.hasVerdict) {
    return 'checking';
  }

  if (input.available) {
    return 'ready';
  }

  if (input.pollingStopped) {
    return 'unreachable';
  }

  if (input.stage === 'propagating') {
    return 'propagating';
  }

  return 'unreachable';
}

/**
 * Whether the public route is worth probing at all. Headless apps have no URL to
 * open, a stopped app has nothing serving, and `local` exposure resolves to a
 * LAN address that is reachable the moment the container binds — the probe would
 * only add latency to an Open button that can already be enabled.
 */
function isProbeApplicable(input: { status?: AppStatus | null; noGui?: boolean; exposureMode?: string | null }): boolean {
  return input.status === 'running' && !input.noGui && (input.exposureMode || 'local') !== 'local';
}

/**
 * Poll an app's public URL and expose one coherent readiness state.
 *
 * Call this once per page and share the result; it owns the poll cadence, the
 * grace window and the give-up budget, so two consumers can never drift apart.
 */
export function useAppUrlAvailability(input: {
  appUrn: string;
  status?: AppStatus | null;
  noGui?: boolean;
  exposureMode?: string | null;
}): AppUrlAvailability {
  const { appUrn, status, noGui, exposureMode } = input;
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const enabled = isProbeApplicable({ status, noGui, exposureMode });

  // Latched windows rather than a `Date.now()` read during render: a rendered
  // clock only advances when something else re-renders the tree, so the grace
  // window used to expire late (or early, after an unrelated update).
  const [graceElapsed, setGraceElapsed] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);
  // Bumping this re-arms the timers and re-runs the probe after reset().
  const [runId, setRunId] = useState(0);
  // When the current run began. React Query keeps its cache entry across a
  // disabled spell (an app stop/start) and across a remount within gcTime, so
  // a verdict older than this belongs to a previous run and must not be
  // trusted — a stale `available: true` would otherwise light up the Open
  // button for a route that has not come back up yet.
  const [runStartedAt, setRunStartedAt] = useState(() => Date.now());

  const queryOptions = useMemo(() => checkAvailabilityOptions({ path: { urn: appUrn } }), [appUrn]);

  const query = useQuery({
    ...queryOptions,
    enabled,
    // The probe is a liveness question, not cacheable data: a stale "available"
    // from a previous visit would light up an Open button for a route that has
    // since gone away.
    staleTime: 0,
    // One request per tick. The generated options set `throwOnError`, so a
    // 401/5xx rejects; retrying here would triple the traffic for a probe that
    // is about to run again anyway.
    retry: false,
    refetchInterval: (q) => {
      const latest = q.state.data as AppUrlProbeResult | undefined;

      return nextProbeDelayMs({ available: Boolean(latest?.available), graceElapsed, pollingStopped }) ?? false;
    },
    // A route usually finishes propagating while the user is looking at another
    // tab; the loop this replaced was a plain setTimeout that never paused, so
    // keep probing in the background rather than stalling until refocus.
    refetchIntervalInBackground: true,
    // ...but don't fire an extra probe *because* of a refocus: a transient blip
    // there could yank an already-enabled Open button back to a spinner.
    refetchOnWindowFocus: false,
  });

  // Only a verdict fetched during THIS run counts; see `runStartedAt`.
  const probe = query.dataUpdatedAt >= runStartedAt ? ((query.data ?? null) as AppUrlProbeResult | null) : null;

  // Re-arm on every change of target or applicability: navigating between two
  // app-detail routes reuses this component, and a stop → start cycle must get a
  // fresh grace window rather than inherit the previous run's exhausted one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: appUrn and runId are deliberate re-arm triggers, not values the effect reads.
  useEffect(() => {
    setGraceElapsed(false);
    setPollingStopped(false);
    setRunStartedAt(Date.now());

    if (!enabled) {
      return;
    }

    const graceTimer = window.setTimeout(() => setGraceElapsed(true), GRACE_PERIOD_MS);
    const giveUpTimer = window.setTimeout(() => setPollingStopped(true), MAX_POLL_MS);

    return () => {
      window.clearTimeout(graceTimer);
      window.clearTimeout(giveUpTimer);
    };
  }, [appUrn, enabled, runId]);

  // A failed request is "no verdict", not "unavailable": the app may well be up
  // and the Hub call is what broke. Keep the UI neutral and let the next tick
  // decide — the same fail-soft stance the old inline catch took.
  //
  // Log once per distinct failure, not once per poll: a probe that keeps
  // failing (an expired session, say) ticks every 3-10s for five minutes, and
  // ~45 identical lines would bury everything else in the console.
  const loggedProbeFailureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!query.error) {
      loggedProbeFailureRef.current = null;
      return;
    }

    const signature = `${appUrn}:${query.error.message}`;
    if (loggedProbeFailureRef.current === signature) {
      return;
    }

    loggedProbeFailureRef.current = signature;
    console.warn('[app-url-availability] probe failed for %s:', appUrn, query.error);
  }, [query.error, appUrn]);

  // Fires once when the budget runs out on a route that never came up (the
  // timer also elapses for healthy apps — that is not worth a warning). The
  // probe fields are context for that single line, not something to re-log on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the probe fields are log context, not triggers.
  useEffect(() => {
    if (pollingStopped && enabled && !probe?.available) {
      console.warn(
        '[app-url-availability] stopped probing %s after %dms (stage=%s, errorCode=%s)',
        appUrn,
        MAX_POLL_MS,
        probe?.stage ?? 'unknown',
        probe?.errorCode ?? 'none',
      );
    }
  }, [pollingStopped, enabled, appUrn]);

  const reset = useCallback(() => {
    // Drop the cached verdict as well as the local latches, so `hasVerdict`
    // falls back to false and the UI returns to a neutral "checking".
    void queryClient.resetQueries({ queryKey: queryOptions.queryKey });
    setRunId((current) => current + 1);
  }, [queryClient, queryOptions.queryKey]);

  const resolveMutation = useMutation({
    ...resolveAvailabilityMutation(),
    onSuccess: (data) => {
      const result = (data ?? {}) as { success?: boolean; detail?: string };

      if (result.success) {
        toast.success(result.detail || t('APP_ACTION_RESOLUTION_ATTEMPTED_RECHECKING'));
        // Give the backend's DNS/tunnel write a beat to take effect before the
        // first re-probe, otherwise we just re-read the broken state.
        window.setTimeout(reset, 3_000);
        return;
      }

      toast.error(result.detail || t('APP_ACTION_RESOLUTION_FAILED'));
    },
    onError: (error: Error) => {
      console.error('[app-url-availability] resolve failed for %s:', appUrn, error);
      toast.error(t('APP_ACTION_FAILED_TO_RESOLVE', { error: error.message || t('COMMON_UNKNOWN_ERROR') }));
    },
  });

  const state = derivePublicUrlState({
    enabled,
    hasVerdict: probe != null,
    available: Boolean(probe?.available),
    stage: probe?.stage ?? null,
    pollingStopped,
  });

  // Only the not-yet-usable states carry an explanation. Prefer the localized
  // copy for a known code, fall back to the backend's own detail string, and
  // only then to generic copy — so the pill tooltip is never empty.
  const messageKey = resolveProbeMessageKey(probe?.errorCode);
  const genericMessageKey = state === 'propagating' ? 'APP_STATUS_RUNNING_PROPAGATING_DETAIL' : 'APP_ACTION_APPLICATION_ERROR';
  const statusMessage =
    state === 'propagating' || state === 'unreachable' ? (messageKey ? t(messageKey) : probe?.detail) || t(genericMessageKey) : null;

  return {
    state,
    appUrl: probe?.appUrl ?? null,
    statusMessage,
    errorCode: probe?.errorCode ?? null,
    resolvable: Boolean(probe?.resolvable),
    withinGracePeriod: !graceElapsed && !pollingStopped,
    pollingStopped,
    isResolving: resolveMutation.isPending,
    resolve: () => resolveMutation.mutate({ path: { urn: appUrn } }),
    reset,
  };
}

/**
 * Inert value for surfaces that have no probe to show (headless apps, tests,
 * any render path where the app is not running). Keeps `AppActions`' prop
 * required — an accidentally missing value would strand its Open button on a
 * spinner forever — without forcing callers to invent one.
 */
export const IDLE_APP_URL_AVAILABILITY: AppUrlAvailability = {
  state: 'idle',
  appUrl: null,
  statusMessage: null,
  errorCode: null,
  resolvable: false,
  withinGracePeriod: false,
  pollingStopped: false,
  isResolving: false,
  resolve: () => undefined,
  reset: () => undefined,
};
