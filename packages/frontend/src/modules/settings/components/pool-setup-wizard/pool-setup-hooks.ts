import { poolStatusOptions, poolStatusQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { approvePeer, listDiscoverable, pairPeer, rejectPeer, removePeer, updatePoolSettings } from '@/api-client/sdk.gen';
import { tailscaleStatusOptions } from '@/lib/api-routes/named-status-routes';
import { useTailscaleReadinessSync } from '@/lib/hooks/use-tailscale-readiness-sync';
import { POLLING } from '@/lib/polling-budget';
import { unwrapSdk } from '@/lib/sdk-unwrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { DiscoverablePoolPeer, PoolStatus } from '../../helpers/hub-pool-shared';
import {
  PAIRING_WAIT_HINT_MS,
  PAIRING_WAIT_MAX_MS,
  type PairFailure,
  type SetupStep,
  type TailscaleSetupStatus,
  classifyPairFailure,
  needsPolling,
  normalizeNodeName,
  statusOf,
} from './pool-setup-model';

/* ── Reads ──────────────────────────────────────────────────────────────────────────────── */

/**
 * This Hub's own Tailscale status, polled only while the readiness step is on screen (that is when
 * the user may be signing in in another tab). The key comes from `named-status-routes`, never a
 * numbered `getStatusN`: those renumber when a `/status` route is added.
 *
 * It does not read `appContext.tailscaleAvailable`: that flag also requires Serve to be enabled and
 * comes from an unpolled query, so it would say "not connected" for a Hub that connected a minute ago.
 */
export function useTailscaleReadiness(step: SetupStep | null) {
  const onReadiness = step === 'ready';
  const query = useQuery({
    ...tailscaleStatusOptions(),
    select: (payload) => payload as unknown as TailscaleSetupStatus,
    refetchInterval: onReadiness ? POLLING.POOL_SETUP_READINESS_MS : false,
    refetchOnWindowFocus: onReadiness,
  });
  // Connecting from the guide must re-publish the Hub over Serve, or pooling still has nothing to reach.
  useTailscaleReadinessSync(query.data);
  return query;
}

/**
 * Pool status for the guide, polled only while it can change under the user's eyes.
 *
 * It polls every {@link POLLING.POOL_SETUP_WAIT_MS} while the approval step is on screen and something
 * is waiting (a request for a human, or a connected Hub whose models are not read yet), and stops when
 * the pool settles, after {@link PAIRING_WAIT_MAX_MS}, when the tab is hidden, or when the guide closes.
 * `resume` re-arms the clock for the Check again button.
 *
 * The clock lives here rather than in a hook of its own because the query's interval needs `expired`
 * and `expired` needs the query's data. Two hooks would be circular.
 */
export function usePoolStatusLive(step: SetupStep | null) {
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(false);
  const [longWait, setLongWait] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const query = useQuery({
    ...poolStatusOptions(),
    select: (payload) => payload as PoolStatus,
    refetchInterval: (q) =>
      step === 'approve' && !expired && needsPolling(q.state.data as PoolStatus | undefined) ? POLLING.POOL_SETUP_WAIT_MS : false,
  });

  const waiting = step === 'approve' && needsPolling(query.data);

  useEffect(() => {
    // `epoch` is read so that `resume` re-runs this effect and arms fresh timers.
    void epoch;
    setExpired(false);
    setLongWait(false);
    if (!waiting) return;
    const hint = setTimeout(() => setLongWait(true), PAIRING_WAIT_HINT_MS);
    const stop = setTimeout(() => {
      setLongWait(true);
      setExpired(true);
    }, PAIRING_WAIT_MAX_MS);
    return () => {
      clearTimeout(hint);
      clearTimeout(stop);
    };
  }, [waiting, epoch]);

  const resume = useCallback(() => setEpoch((value) => value + 1), []);

  // Reading `dataUpdatedAt` subscribes this render to every successful fetch, including one that returns
  // identical data; the count itself lives on the query's state, not on the observer's result.
  const dataUpdateCount = query.dataUpdatedAt ? (queryClient.getQueryState(poolStatusQueryKey())?.dataUpdateCount ?? 0) : 0;

  return { query, longWait, expired, resume, dataUpdateCount };
}

/**
 * One scan of the tailnet for Hubs to pair with. A mutation on purpose, not a query: the route probes
 * every unpaired tailnet device (5 s each) and may call the Portal and the Tailscale API, so it runs
 * when the user enters the step or presses Scan again, and nothing else may trigger it. A query would
 * be refetched by any `invalidateQueries` and by the resume-from-sleep refresh, which invalidates every query.
 */
export function useDiscoveryScan() {
  return useMutation({
    mutationFn: async () => (await unwrapSdk(listDiscoverable())) as DiscoverablePoolPeer[],
  });
}

/* ── Sending ────────────────────────────────────────────────────────────────────────────── */

export interface PairTarget {
  nodeFqdn: string;
  hostname: string;
  /** What the tailnet said about the device when it was found. Carried so the Hub's card keeps its OS and presence after Send. */
  os?: string;
  online?: boolean;
}

export type PairRowStatus = 'queued' | 'sending' | 'sent' | 'already' | 'failed';

export interface PairRow extends PairTarget {
  status: PairRowStatus;
  failure?: PairFailure;
  /** A PIN was sent with this request. Used only to word the failure hint. */
  usedPin: boolean;
}

interface BatchState {
  rows: Record<string, PairRow>;
  /** The rows the Connect step shows, in order. Earlier batches stay in `rows` so a vanished request is still noticed. */
  current: string[];
  /**
   * How many times pool status had been fetched when the last send settled. A request is only called
   * gone by a status fetched after that: one fetched earlier has simply not seen the new row yet.
   * A count, not a timestamp: two events in the same millisecond cannot be ordered by `Date.now()`.
   */
  settledAfterUpdate: number | null;
  /** Requests the user cancelled here, so their disappearance is not reported as a surprise. */
  cancelled: string[];
}

type BatchAction =
  | { type: 'begin'; targets: PairTarget[]; usedPin: boolean; replaceCurrent: boolean }
  | { type: 'mark'; nodeFqdn: string; patch: Partial<PairRow> }
  | { type: 'settle'; afterUpdate: number }
  | { type: 'cancelled'; nodeFqdn: string };

const initialBatch: BatchState = { rows: {}, current: [], settledAfterUpdate: null, cancelled: [] };

function batchReducer(state: BatchState, action: BatchAction): BatchState {
  switch (action.type) {
    case 'begin': {
      const rows = { ...state.rows };
      for (const target of action.targets) {
        rows[target.nodeFqdn] = { ...target, status: 'queued', usedPin: action.usedPin };
      }
      return {
        ...state,
        rows,
        current: action.replaceCurrent ? action.targets.map((target) => target.nodeFqdn) : state.current,
        cancelled: state.cancelled.filter((fqdn) => !action.targets.some((target) => target.nodeFqdn === fqdn)),
      };
    }
    case 'mark': {
      const row = state.rows[action.nodeFqdn];
      if (!row) return state;
      return { ...state, rows: { ...state.rows, [action.nodeFqdn]: { ...row, ...action.patch } } };
    }
    case 'settle':
      return { ...state, settledAfterUpdate: action.afterUpdate };
    case 'cancelled':
      return state.cancelled.includes(action.nodeFqdn) ? state : { ...state, cancelled: [...state.cancelled, action.nodeFqdn] };
    default:
      return state;
  }
}

/**
 * Sends pairing requests and tracks each one.
 *
 * The one rule: never send a request twice. The server already answers 409 for a Hub that has any peer
 * row, and discovery already hides those Hubs. On top of that, every send re-reads pool status first and
 * skips any Hub that now has a row, and an in-flight set drops a double click. Batch state is
 * deliberately not persisted: a reopened guide starts on Approve whenever any row exists, so it never
 * shows Connect for a request that was already made.
 */
export function usePairingBatch() {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(batchReducer, initialBatch);
  const inFlight = useRef(new Set<string>());
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    return () => {
      // Closing the guide stops sends that have not begun. One already on the wire finishes on the server.
      stopped.current = true;
    };
  }, []);

  const pairOne = useCallback(async (target: PairTarget, pin: string | undefined) => {
    if (inFlight.current.has(target.nodeFqdn)) return;
    inFlight.current.add(target.nodeFqdn);
    dispatch({ type: 'mark', nodeFqdn: target.nodeFqdn, patch: { status: 'sending', failure: undefined } });
    try {
      // `as never`: the generated PairPeerBody is an index signature with no named fields.
      const result = await pairPeer({ body: { nodeFqdn: target.nodeFqdn, displayName: target.hostname, ...(pin ? { pin } : {}) } as never });
      if (result?.error) {
        const failure = classifyPairFailure(statusOf(result.error, result.response));
        dispatch({ type: 'mark', nodeFqdn: target.nodeFqdn, patch: failure === 'already' ? { status: 'already' } : { status: 'failed', failure } });
      } else {
        dispatch({ type: 'mark', nodeFqdn: target.nodeFqdn, patch: { status: 'sent' } });
      }
    } catch (error) {
      const failure = classifyPairFailure(statusOf(error));
      dispatch({ type: 'mark', nodeFqdn: target.nodeFqdn, patch: failure === 'already' ? { status: 'already' } : { status: 'failed', failure } });
    } finally {
      inFlight.current.delete(target.nodeFqdn);
    }
  }, []);

  const run = useCallback(
    async (targets: PairTarget[], pin: string | undefined) => {
      // A fresh read, not the cache: the cache may be 15 s old, and a row made since then is exactly the one to skip.
      let existing = new Set<string>();
      try {
        const live = (await queryClient.fetchQuery({ ...poolStatusOptions(), staleTime: 0 })) as PoolStatus;
        existing = new Set(live.peers.map((peer) => normalizeNodeName(peer.nodeFqdn)));
      } catch {
        // The server's 409 is the real guard; an unreadable status must not stop the send.
      }
      if (stopped.current) return;

      await Promise.all(
        targets.map(async (target) => {
          if (existing.has(normalizeNodeName(target.nodeFqdn))) {
            dispatch({ type: 'mark', nodeFqdn: target.nodeFqdn, patch: { status: 'already' } });
            return;
          }
          await pairOne(target, pin);
        }),
      );

      // Counted before the refetch below, so only a status that completes after this point can report a request gone.
      dispatch({ type: 'settle', afterUpdate: queryClient.getQueryState(poolStatusQueryKey())?.dataUpdateCount ?? 0 });
      // Pool status only. The discovery list is never invalidated: refreshing it would re-probe the whole tailnet.
      await queryClient.invalidateQueries({ queryKey: poolStatusQueryKey() });
    },
    [pairOne, queryClient],
  );

  const send = useCallback(
    async (targets: PairTarget[], pin?: string) => {
      dispatch({ type: 'begin', targets, usedPin: Boolean(pin), replaceCurrent: true });
      await run(targets, pin);
    },
    [run],
  );

  /**
   * Re-sends one request. The PIN is not carried over: it was single use and the server consumed it.
   * A row that is not on the Connect step's list (a vanished request, pressed on Approve) becomes the list.
   */
  const retry = useCallback(
    async (nodeFqdn: string, hostname: string) => {
      const previous = state.rows[nodeFqdn];
      const target: PairTarget = { nodeFqdn, hostname, os: previous?.os, online: previous?.online };
      dispatch({ type: 'begin', targets: [target], usedPin: false, replaceCurrent: !state.current.includes(nodeFqdn) });
      await run([target], undefined);
    },
    [run, state.current, state.rows],
  );

  const retryFailed = useCallback(async () => {
    const failed = state.current.map((fqdn) => state.rows[fqdn]).filter((row): row is PairRow => row?.status === 'failed');
    if (failed.length === 0) return;
    const targets = failed.map(({ nodeFqdn, hostname, os, online }) => ({ nodeFqdn, hostname, os, online }));
    dispatch({ type: 'begin', targets, usedPin: false, replaceCurrent: false });
    await run(targets, undefined);
  }, [run, state.current, state.rows]);

  const markCancelled = useCallback((nodeFqdn: string) => dispatch({ type: 'cancelled', nodeFqdn }), []);

  const currentRows = state.current.map((fqdn) => state.rows[fqdn]).filter((row): row is PairRow => Boolean(row));
  const allRows = Object.values(state.rows);

  return {
    send,
    retry,
    retryFailed,
    markCancelled,
    currentRows,
    sending: currentRows.some((row) => row.status === 'queued' || row.status === 'sending'),
    /** Hubs a request was sent to in this session and nothing has gone wrong with. */
    sentRows: allRows.filter((row) => row.status === 'sent'),
    settledAfterUpdate: state.settledAfterUpdate,
    cancelled: state.cancelled,
  };
}

/* ── Small mutations ────────────────────────────────────────────────────────────────────── */

/** Throws with the HTTP status attached, so a caller can tell "gone" (404) from "broken". */
class PoolSetupRequestError extends Error {
  constructor(readonly status: number | undefined) {
    super(`Hub Pool request failed${status ? ` (${status})` : ''}`);
    this.name = 'PoolSetupRequestError';
  }
}

async function callSdk(promise: Promise<{ error?: unknown; response?: Response } | undefined>): Promise<void> {
  const result = await promise;
  if (result?.error) throw new PoolSetupRequestError(statusOf(result.error, result.response));
}

const errorStatus = (error: unknown) => (error instanceof PoolSetupRequestError ? error.status : statusOf(error));

/**
 * Approve, reject, cancel, unpair and "turn on Hub Pool". Each refreshes pool status in `onSettled`, which
 * lives on the hook rather than on the `mutate` call so it still runs if the guide closed mid-request.
 */
export function usePoolSetupMutations() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: poolStatusQueryKey() });
  };

  /** A 404 means the row is already gone (approved, rejected, expired or withdrawn): information, not a failure. */
  const decide = (successKey: string, errorKey: string) => ({
    onSuccess: () => toast.success(t(successKey)),
    onError: (error: unknown) => (errorStatus(error) === 404 ? toast.info(t('HUB_POOL_SETUP_REQUEST_GONE')) : toast.error(t(errorKey))),
    onSettled: refresh,
  });

  const approve = useMutation({
    mutationFn: (id: string) => callSdk(approvePeer({ path: { id } })),
    ...decide('HUB_POOL_APPROVE_SUCCESS', 'HUB_POOL_APPROVE_ERROR'),
  });

  const reject = useMutation({
    mutationFn: (id: string) => callSdk(rejectPeer({ path: { id } })),
    ...decide('HUB_POOL_REJECT_SUCCESS', 'HUB_POOL_REJECT_ERROR'),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => callSdk(removePeer({ path: { id } })),
    ...decide('HUB_POOL_CANCEL_REQUEST_SUCCESS', 'HUB_POOL_CANCEL_REQUEST_ERROR'),
  });

  /**
   * Removes a pairing that is established or half made, the way the Settings panel's Unpair does. The
   * same `removePeer` call as `cancel`, with its own toasts: a 404 here is no "request gone" news. The
   * Hub also tells the other side, with the token it stored for it, so a request still waiting there is
   * cleared too when that Hub can be reached.
   */
  const unpair = useMutation({
    mutationFn: (id: string) => callSdk(removePeer({ path: { id } })),
    onSuccess: () => toast.success(t('HUB_POOL_UNPAIR_SUCCESS')),
    onError: () => toast.error(t('HUB_POOL_UNPAIR_ERROR')),
    onSettled: refresh,
  });

  const enablePooling = useMutation({
    mutationFn: () => callSdk(updatePoolSettings({ body: { poolEnabled: true } })),
    onSuccess: () => toast.success(t('HUB_POOL_SETTINGS_SAVED')),
    onError: () => toast.error(t('HUB_POOL_SETUP_POOLING_ERROR')),
    onSettled: refresh,
  });

  return { approve, reject, cancel, unpair, enablePooling };
}
