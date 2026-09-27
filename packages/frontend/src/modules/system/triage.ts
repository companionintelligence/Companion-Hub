import { humanDuration } from '@/components/ui/dense/dense';
import type { LoadState } from '@/modules/system/use-dashboard-data';

/*
 * ONE VERDICT FOR THE WHOLE PAGE, and the only interesting thing about it is what it refuses
 * to say.
 *
 * `PanelBody` already keeps "still loading", "the request failed" and "it loaded and there is
 * genuinely nothing" apart at panel scale. This is that same contract promoted to page scale,
 * because the summary line at the top of a monitoring page is the one an operator reads INSTEAD
 * of the panels — and a green ALL CLEAR that was computed while four of the eight queries were
 * failing is worse than no summary at all. It states that everything was checked, when in truth
 * most of it could not be.
 *
 * Hence three claims, not two:
 *
 *   'clear'   — every query answered, and nothing in what they said is wrong.
 *   'partial' — nothing wrong in what DID answer, and N checks could not run. The honest middle.
 *   'faults'  — something measured is wrong, listed.
 *
 * And the rule that makes the middle state mean anything: A FAILED QUERY NEVER PRODUCES A FAULT.
 * "We could not check" and "we checked and it is broken" send an operator to opposite places —
 * one to the network, one to the machine — so they are counted in different buckets and are
 * never allowed to bleed into each other. Every fault below is gated on the state of the query
 * that measured it, here rather than at the call site, so a caller that forgets to zero its
 * inputs on failure still cannot manufacture a fault out of undefined data.
 */

export interface Fault {
  /** Stable identity, for keys and for tests. Not shown to anyone. */
  id: string;
  label: string;
  tone: 'warn' | 'bad';
}

export interface Verdict {
  kind: 'pending' | 'clear' | 'partial' | 'faults';
  faults: Fault[];
  /** Dashboard queries that failed. Never folded into `faults`. */
  unavailable: number;
}

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * How old a container sample may be, when the Hub hands it over, before the page says so.
 *
 * The backend samples every 60s and caches a sample for 30s, so a healthy Hub never serves one
 * older than ~90s plus a slow collection (a cold one took 3.4s on core-2). Three minutes is two
 * missed collections. Past it the monitor is failing — and it fails SILENTLY by design: a collection
 * that throws returns the previous snapshot and resets the cache clock, so the same figures come
 * back on every poll with nothing but `sampledAt` to say they have stopped moving.
 */
export const STALE_SAMPLE_MS = 180_000;

/**
 * The share of its first-byte budget a waiting request may use before the page warns. At the budget
 * the proxy gives up on that node and fails over, so this is the last point at which a person can
 * still see it coming.
 */
export const NEAR_BUDGET_SHARE = 0.8;

/**
 * The request waiting longest for its first byte, reduced to what the verdict needs. `node` is
 * already a display label — the caller owns translating `'local'`.
 */
export interface WaitingRequest {
  ageMs: number;
  budgetMs: number | null;
  node: string;
}

/**
 * Everything the verdict is allowed to look at, grouped BY THE QUERY THAT MEASURED IT.
 *
 * The grouping is the point. A flat bag of counts could not tell whether `degraded: 0` meant
 * "no workload is degraded" or "the container snapshot never arrived", which is precisely the
 * distinction this module exists to preserve.
 */
export interface VerdictInput {
  containers: {
    state: LoadState;
    degraded: number;
    /** How old the sample was when the Hub served it, or `null`/absent when unknown. See {@link STALE_SAMPLE_MS}. */
    sampleAgeMs?: number | null;
  };
  pool: {
    state: LoadState;
    unreachablePeers: number;
    /** Nodes with a non-zero `consecutiveFailures` — probing is failing but the peer is not yet out. */
    probeFailures: number;
    stalePins: number;
    envDisabledDirections: number;
    /** This node's own engine inventory could not be refreshed, so what it advertises is stale. */
    capabilitiesError: boolean;
  };
  routing: {
    state: LoadState;
    /** Requests with no candidate at all, placed INSIDE the rail's window — never the whole ring. */
    unplaced: number;
    /** The oldest request still waiting for its first byte, or `null`/absent when none is. */
    waiting?: WaitingRequest | null;
  };
  /** Queries that carry no fault of their own but still count towards "was everything checked". */
  otherStates: LoadState[];
  t: Translate;
}

export function pageVerdict(input: VerdictInput): Verdict {
  const { containers, pool, routing, otherStates, t } = input;
  const states = [containers.state, pool.state, routing.state, ...otherStates];

  const unavailable = states.filter((state) => state.failed).length;
  const pending = states.some((state) => state.pending);
  const faults: Fault[] = [];

  // Each block is gated on ITS OWN query having answered. A failed fetch contributes to
  // `unavailable` above and to nothing else, whatever numbers happen to be in the input.
  if (!containers.state.failed && containers.degraded > 0) {
    faults.push({ id: 'workloads-degraded', tone: 'bad', label: t('DASHBOARD_VERDICT_DEGRADED', { count: containers.degraded }) });
  }
  // `warn`, not `bad`: nothing measured is wrong — the measuring has stopped, and every container
  // figure on the page is that old. It is the reason to distrust them, which is worth a chip.
  if (!containers.state.failed && typeof containers.sampleAgeMs === 'number' && containers.sampleAgeMs > STALE_SAMPLE_MS) {
    faults.push({ id: 'stale-sample', tone: 'warn', label: t('DASHBOARD_VERDICT_STALE_SAMPLE', { age: humanDuration(containers.sampleAgeMs) }) });
  }

  if (!pool.state.failed) {
    if (pool.unreachablePeers > 0) {
      faults.push({ id: 'peers-unreachable', tone: 'bad', label: t('DASHBOARD_VERDICT_PEERS_UNREACHABLE', { count: pool.unreachablePeers }) });
    }
    if (pool.probeFailures > 0) {
      faults.push({ id: 'probe-failures', tone: 'warn', label: t('DASHBOARD_VERDICT_PROBE_FAILURES', { count: pool.probeFailures }) });
    }
    if (pool.stalePins > 0) {
      faults.push({ id: 'stale-pins', tone: 'warn', label: t('DASHBOARD_VERDICT_STALE_PINS', { count: pool.stalePins }) });
    }
    if (pool.envDisabledDirections > 0) {
      faults.push({ id: 'env-disabled', tone: 'warn', label: t('DASHBOARD_VERDICT_ENV_DISABLED', { count: pool.envDisabledDirections }) });
    }
    // Also surfaced inside the configuration drawer, which collapses. A collapsed drawer must
    // never be the only place a fault is visible, so it is raised here as well.
    if (pool.capabilitiesError) {
      faults.push({ id: 'capabilities-error', tone: 'warn', label: t('DASHBOARD_VERDICT_CAPABILITIES_ERROR') });
    }
  }

  // Unplaced is deliberately `bad` and deliberately separate from a failed request: nothing was
  // even tried at a node, which is a routing/capacity problem rather than a node problem. It is a
  // count over the rail's WINDOW: summed over the whole ring it kept a Hub red for as long as one
  // bad row survived there, which on a quiet Hub is days.
  if (!routing.state.failed && routing.unplaced > 0) {
    faults.push({ id: 'unplaced', tone: 'bad', label: t('DASHBOARD_VERDICT_UNPLACED', { count: routing.unplaced }) });
  }
  // A wait is not a fault until it is about to become one: minutes-long first bytes are normal for
  // an agent turn here. At the budget the proxy abandons the node, so 80% is the warning.
  const waiting = routing.waiting;
  if (
    !routing.state.failed &&
    waiting &&
    waiting.budgetMs !== null &&
    waiting.budgetMs > 0 &&
    waiting.ageMs >= NEAR_BUDGET_SHARE * waiting.budgetMs
  ) {
    faults.push({
      id: 'near-budget',
      tone: 'warn',
      label: t('DASHBOARD_VERDICT_NEAR_BUDGET', { age: humanDuration(waiting.ageMs), budget: humanDuration(waiting.budgetMs), node: waiting.node }),
    });
  }

  // Order matters and it is not arbitrary. A measured fault outranks an unfinished check, because
  // it is true whatever the missing checks would have said. An unavailable check outranks
  // "pending" and outranks "clear" ABSOLUTELY: `clear` is a claim that everything ran.
  if (faults.length > 0) return { kind: 'faults', faults, unavailable };
  if (unavailable > 0) return { kind: 'partial', faults, unavailable };
  if (pending) return { kind: 'pending', faults, unavailable };

  return { kind: 'clear', faults, unavailable };
}
