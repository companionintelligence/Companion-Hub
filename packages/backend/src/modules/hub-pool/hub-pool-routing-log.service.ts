import { Injectable } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';
import type { PoolPinMode, PoolPinScope, PoolPinTargetKind } from '@/common/helpers/hub-pool';

/** How many routing decisions are retained. ~200 bytes each, so the whole buffer is well under 100 KB. */
export const ROUTING_LOG_CAPACITY = 200;

/**
 * What happened to a request the proxy tried to route. `pending` is a request that has been placed
 * on a candidate and is waiting for its first byte — for an agent turn on a self-hosted engine that
 * wait is minutes, and until it was recorded the operator saw nothing at all.
 */
export type PoolRoutingOutcome = 'served' | 'failed' | 'pending';

/**
 * One routing decision. Metadata only — never the request body, the prompt, the response, or any
 * header — because this is read back over an operator endpoint and inference payloads are the most
 * sensitive thing passing through the Hub.
 */
export interface PoolRoutingRecord {
  at: string;
  /** 'outbound' = an app on this Hub asked us to route; 'inbound' = a peer forwarded work to our engines. */
  direction: 'outbound' | 'inbound';
  /** The upstream path (`/v1/chat/completions`, …), not the pool route the app called. */
  path: string;
  /** Absent for inbound work: a peer picks the backend and does not tell us which model it wants. */
  model: string | null;
  /**
   * The other end of the decision: for `outbound`, the node that served it (`'local'` for this one,
   * `null` when nothing did); for `inbound`, the peer that sent us the work (`null` if it did not
   * identify itself).
   */
  node: string | null;
  peerId: string | null;
  backend: InferenceBackendType | null;
  /** How many candidates the ranking produced for this request. 1 for inbound (a peer forward is never re-routed). */
  candidates: number;
  /** 1-based position of the serving candidate in that ranked list; >1 means earlier candidates were tried and rejected. */
  attempt: number;
  /** Nodes tried before this one, in order. Non-empty exactly when this was a failover. */
  failedOverFrom: string[];
  /**
   * The operator pin that shaped this decision's candidate order, or `null`.
   *
   * Without it an operator watching everything land on one node cannot tell a pin from the ranker
   * doing its job — which is the single question this log exists to answer. Always `null` on
   * `inbound` rows: a pin is this Hub's policy for work it originates, and a peer's forward is
   * never re-routed.
   */
  pin: PoolRoutingPin | null;
  outcome: PoolRoutingOutcome;
  /** Upstream status once headers arrived; `null` when no candidate ever answered. */
  status: number | null;
  /**
   * Time from the proxy receiving the request to response headers — including failed attempts — not
   * the streamed generation, which continues afterwards. `null` while the request is `pending`.
   */
  durationMs: number | null;
  /**
   * Token counts, attached separately from `settle()` — settling happens at response headers, but
   * a token count does not exist until generation finishes. `null` until then, and stays `null`
   * forever when the backend's response never carried a usage frame (see `response-usage-tap.ts`:
   * not every dialect reports one, and this is never estimated from `durationMs` or byte counts).
   */
  usage: PoolRoutingUsage | null;
}

/** Token counts as a backend reported them. Any field the response omitted is `null`, not summed around. */
export interface PoolRoutingUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/** A pin as the routing log records it: shape only, never the model or the peer id — the record already has both. */
export interface PoolRoutingPin {
  scope: PoolPinScope;
  mode: PoolPinMode;
  targetKind: PoolPinTargetKind;
}

export interface PoolRoutingSummary {
  recorded: number;
  capacity: number;
  served: number;
  failed: number;
  /** Placed on a candidate and still waiting for its first byte. */
  pending: number;
  /** Records with a non-empty `failedOverFrom`, i.e. requests that a candidate rejected before one answered. */
  failovers: number;
  lastAt: string | null;
}

/**
 * A bounded, in-memory log of recent pool routing decisions.
 *
 * Nothing else in the module records which node served a request: the proxy copies upstream headers
 * verbatim and adds none of its own, and its failover warnings go to `@nestjs/common` Logger
 * (stdout), not the winston file log — so "read it from the logs" is not something an operator or
 * the UI can actually do. This is the answer to "where did that request go, and did it fail over".
 *
 * In-memory and process-local by design, matching the `ModelRegistryService` precedent: a
 * per-request database write on the inference hot path would cost more than the observability is
 * worth, and a routing decision has no value once the process that made it is gone.
 */
@Injectable()
export class HubPoolRoutingLogService {
  private readonly entries: PoolRoutingRecord[] = [];

  record(entry: PoolRoutingRecord): void {
    this.entries.push(entry);
    if (this.entries.length > ROUTING_LOG_CAPACITY) {
      this.entries.splice(0, this.entries.length - ROUTING_LOG_CAPACITY);
    }
  }

  /**
   * Record a request the moment it is placed, as `pending`, and hand back the row so the proxy can
   * keep it current through failovers and settle it when headers arrive. The row is the same object
   * the ring holds, so every later `list()` reflects the update without a second entry — a request
   * that fails over three times is still one line, as before. If the ring has already evicted the
   * row by the time it settles, the mutation is harmless.
   */
  open(entry: Omit<PoolRoutingRecord, 'outcome' | 'status' | 'durationMs' | 'usage'>): PoolRoutingRecord {
    const row: PoolRoutingRecord = { ...entry, outcome: 'pending', status: null, durationMs: null, usage: null };
    this.record(row);
    return row;
  }

  /** Move a row out of `pending`. Fields not given keep what the placement wrote. */
  settle(row: PoolRoutingRecord, patch: Partial<PoolRoutingRecord> & { outcome: 'served' | 'failed' }): void {
    Object.assign(row, patch);
  }

  /**
   * Attach token usage once the backend's response finishes, well after `settle()` already
   * recorded the outcome at headers time. Same object-reference mutation as `settle()`, and the
   * same tolerance for a row the ring has already evicted — a slow generation can outlive its own
   * row's place in a 200-entry buffer, and that is not a bug in this method.
   */
  attachUsage(row: PoolRoutingRecord, usage: PoolRoutingUsage): void {
    row.usage = usage;
  }

  /** Newest first, so a UI showing only the first page shows the most recent decisions. */
  list(limit = ROUTING_LOG_CAPACITY): PoolRoutingRecord[] {
    return this.entries.slice(-limit).reverse();
  }

  summary(): PoolRoutingSummary {
    let served = 0;
    let pending = 0;
    let failovers = 0;
    for (const entry of this.entries) {
      if (entry.outcome === 'served') served += 1;
      if (entry.outcome === 'pending') pending += 1;
      if (entry.failedOverFrom.length > 0) failovers += 1;
    }
    return {
      recorded: this.entries.length,
      capacity: ROUTING_LOG_CAPACITY,
      served,
      failed: this.entries.length - served - pending,
      pending,
      failovers,
      lastAt: this.entries[this.entries.length - 1]?.at ?? null,
    };
  }
}
