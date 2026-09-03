import { checkAvailabilityOptions, resolveAvailabilityMutation } from '@/api-client/@tanstack/react-query.gen';
import type { AppStatus } from '@/types/app.types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/**
 * Public-route readiness differs from container health because tunnel and DNS publication can lag a running app.
 * Sharing this state keeps status and launch controls consistent and limits each page to one poll loop.
 */

/** Probe stages returned by `GET /api/apps/:urn/check-availability`. */
export type AppUrlProbeStage = 'ready' | 'propagating' | 'error';

/** Narrow the endpoint's generated `unknown` type once instead of casting in every consumer. */
export interface AppUrlProbeResult {
  available: boolean;
  appUrl?: string;
  /** Direct LAN address, present even on failure verdicts (see the backend's AppAvailabilityResult). */
  localUrl?: string;
  stage?: AppUrlProbeStage;
  detail?: string;
  errorCode?: string;
  resolvable?: boolean;
}

export type AppPublicUrlState = 'idle' | 'checking' | 'ready' | 'propagating' | 'unreachable';

export interface AppUrlAvailability {
  state: AppPublicUrlState;
  /** Preserve the last URL so a sparse failure verdict cannot remove the "Open anyway" escape hatch. */
  appUrl: string | null;
  /**
   * Keep the LAN address independent of public state because an app can remain locally reachable while its tunnel is down.
   */
  localUrl: string | null;
  /** Already-translated explanation ("DNS propagating..."); null when ready/idle. */
  statusMessage: string | null;
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
/** Beat between a successful repair and the re-probe, so the write can take effect. */
const RESOLVE_RECHECK_DELAY_MS = 3_000;

/**
 * Map `UNKNOWN` so raw Node exceptions never reach users through the backend detail fallback.
 * Keep these keys aligned with `checkAppAvailability`.
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
  NO_DEVICE_REGISTRATION: 'APP_ACTION_ERROR_NO_DEVICE_REGISTRATION',
  // Without this the user saw the backend's raw English detail string.
  TAILSCALE_NOT_READY: 'APP_ACTION_ERROR_TAILSCALE_NOT_READY',
  UNKNOWN: 'APP_ACTION_APPLICATION_ERROR',
};

export function resolveProbeMessageKey(errorCode: string | null | undefined): string | null {
  if (!errorCode) {
    return null;
  }

  return PROBE_MESSAGE_KEYS[errorCode] ?? null;
}

/** A pure cadence function keeps the stop conditions testable without a live query. */
export function nextProbeDelayMs(input: { available: boolean; graceElapsed: boolean; pollingStopped: boolean }): number | null {
  if (input.available || input.pollingStopped) {
    return null;
  }

  return input.graceElapsed ? NORMAL_POLL_MS : GRACE_POLL_MS;
}

/**
 * Precedence is load-bearing: disabled probes stay idle, and success wins over stale failure signals.
 * An exhausted budget precedes a missing verdict so repeated request failures cannot leave a stopped poll on a permanent spinner.
 * Before exhaustion, a failed request remains neutral because it says nothing about app availability.
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

  if (input.available) {
    return 'ready';
  }

  if (input.pollingStopped) {
    return 'unreachable';
  }

  if (!input.hasVerdict) {
    return 'checking';
  }

  if (input.stage === 'propagating') {
    return 'propagating';
  }

  return 'unreachable';
}

/** Skip probes when no public route exists or when local exposure can open as soon as the container binds. */
function isProbeApplicable(input: { status?: AppStatus | null; noGui?: boolean; exposureMode?: string | null }): boolean {
  return input.status === 'running' && !input.noGui && (input.exposureMode || 'local') !== 'local';
}

/**
 * A ref preserves fallback URLs without causing a render.
 * Resetting during render prevents the first frame for a new app from receiving the previous app's URL.
 * Storing and checking the key with the URL also prevents discarded concurrent renders from exposing a stale value.
 */
function useLastKnownUrl(value: string | undefined, resetKey: string): string | null {
  const ref = useRef<{ key: string; url: string | null }>({ key: resetKey, url: null });

  if (ref.current.key !== resetKey) {
    ref.current = { key: resetKey, url: null };
  }

  if (value) {
    ref.current = { key: resetKey, url: value };
  }

  return ref.current.key === resetKey ? ref.current.url : null;
}

/**
 * Call once per page so consumers share the poll cadence, grace window, and give-up budget.
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

  // Timer-driven state keeps grace expiry independent of unrelated renders.
  const [graceElapsed, setGraceElapsed] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [runId, setRunId] = useState(0);

  const queryOptions = useMemo(() => checkAvailabilityOptions({ path: { urn: appUrn } }), [appUrn]);

  const query = useQuery({
    ...queryOptions,
    enabled,
    // Drop verdicts between runs so a restart cannot reuse an old success and enable Open too early.
    // The UI and polling cadence then read the same run's verdict.
    gcTime: 0,
    // Scheduled polling already retries, so query retries would only multiply traffic.
    retry: false,
    refetchInterval: (q) => {
      const latest = q.state.data as AppUrlProbeResult | undefined;

      return nextProbeDelayMs({ available: Boolean(latest?.available), graceElapsed, pollingStopped }) ?? false;
    },
    // Keep probing in background tabs so propagation does not stall until refocus.
    refetchIntervalInBackground: true,
    // Avoid a refocus-only blip that could replace an enabled Open button with a spinner.
    refetchOnWindowFocus: false,
  });

  const probe = (query.data ?? null) as AppUrlProbeResult | null;
  const routeAvailable = Boolean(probe?.available);

  // A new app or stop-start cycle needs a fresh grace window and polling budget.
  // Once the route answers, timers would only cause stale state updates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: appUrn and runId are deliberate re-arm triggers, not values the effect reads.
  useEffect(() => {
    setGraceElapsed(false);
    setPollingStopped(false);

    if (!enabled) {
      // Evict disabled runs so a restarted app cannot recover its pre-stop verdict.
      queryClient.removeQueries({ queryKey: queryOptions.queryKey });
      return;
    }

    if (routeAvailable) {
      return;
    }

    const graceTimer = window.setTimeout(() => setGraceElapsed(true), GRACE_PERIOD_MS);
    const giveUpTimer = window.setTimeout(() => {
      setPollingStopped(true);
      // Read current data so the warning describes the verdict that exhausted the budget.
      const latest = queryClient.getQueryData(queryOptions.queryKey) as AppUrlProbeResult | undefined;
      console.warn(
        '[app-url-availability] stopped probing %s after %dms (stage=%s, errorCode=%s)',
        appUrn,
        MAX_POLL_MS,
        latest?.stage ?? 'unknown',
        latest?.errorCode ?? 'none',
      );
    }, MAX_POLL_MS);

    return () => {
      window.clearTimeout(graceTimer);
      window.clearTimeout(giveUpTimer);
    };
  }, [appUrn, enabled, runId, routeAvailable, queryClient, queryOptions.queryKey]);

  // Preserve escape-hatch URLs across sparse verdicts so a transient registration or VPN failure cannot remove access.
  // Both latches reset per app.
  const lastKnownAppUrl = useLastKnownUrl(probe?.appUrl, appUrn);
  const lastKnownLocalUrl = useLastKnownUrl(probe?.localUrl, appUrn);

  // A failed Hub request says nothing about the app, so keep the UI neutral until another probe decides.
  // Deduplicate failures because repeated polling would otherwise flood the console.
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

  const reset = useCallback(() => {
    // Reset the verdict to neutral while preserving same-app escape-hatch URLs during repair.
    void queryClient.resetQueries({ queryKey: queryOptions.queryKey });
    setRunId((current) => current + 1);
  }, [queryClient, queryOptions.queryKey]);

  // Cancel deferred rechecks so navigation or repeated Resolve clicks cannot rearm the wrong app's budget.
  const resolveRecheckTimerRef = useRef<number | null>(null);
  const clearResolveRecheck = useCallback(() => {
    if (resolveRecheckTimerRef.current !== null) {
      window.clearTimeout(resolveRecheckTimerRef.current);
      resolveRecheckTimerRef.current = null;
    }
  }, []);
  // Cancel when the target changes so a pending recheck cannot land on another app.
  // biome-ignore lint/correctness/useExhaustiveDependencies: appUrn is a deliberate cancel trigger, not a value the effect reads.
  useEffect(() => clearResolveRecheck, [clearResolveRecheck, appUrn]);

  const resolveMutation = useMutation({
    ...resolveAvailabilityMutation(),
    onSuccess: (data) => {
      const result = (data ?? {}) as { success?: boolean; detail?: string };

      if (result.success) {
        toast.success(result.detail || t('APP_ACTION_RESOLUTION_ATTEMPTED_RECHECKING'));
        // Delay the probe long enough for the backend's DNS or tunnel write to take effect.
        clearResolveRecheck();
        resolveRecheckTimerRef.current = window.setTimeout(() => {
          resolveRecheckTimerRef.current = null;
          reset();
        }, RESOLVE_RECHECK_DELAY_MS);
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
    available: routeAvailable,
    stage: probe?.stage ?? null,
    pollingStopped,
  });

  // Prefer localized error copy, but always provide a fallback for the status tooltip.
  const messageKey = resolveProbeMessageKey(probe?.errorCode);
  const genericMessageKey = state === 'propagating' ? 'APP_STATUS_RUNNING_PROPAGATING_DETAIL' : 'APP_ACTION_APPLICATION_ERROR';
  const statusMessage =
    state === 'propagating' || state === 'unreachable' ? (messageKey ? t(messageKey) : probe?.detail) || t(genericMessageKey) : null;

  return {
    state,
    appUrl: probe?.appUrl ?? lastKnownAppUrl,
    localUrl: probe?.localUrl ?? lastKnownLocalUrl,
    statusMessage,
    resolvable: Boolean(probe?.resolvable),
    withinGracePeriod: !graceElapsed && !pollingStopped,
    pollingStopped,
    isResolving: resolveMutation.isPending,
    resolve: () => resolveMutation.mutate({ path: { urn: appUrn } }),
    reset,
  };
}

/**
 * Keep the availability prop required so an omitted value cannot strand Open on a spinner.
 * Non-probing surfaces share this inert value instead of inventing one.
 */
export const IDLE_APP_URL_AVAILABILITY: AppUrlAvailability = {
  state: 'idle',
  appUrl: null,
  localUrl: null,
  statusMessage: null,
  resolvable: false,
  withinGracePeriod: false,
  pollingStopped: false,
  isResolving: false,
  resolve: () => undefined,
  reset: () => undefined,
};
