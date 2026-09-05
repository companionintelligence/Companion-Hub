import { Injectable } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';

/** How many routing decisions are retained. ~200 bytes each, so the whole buffer is well under 100 KB. */
export const ROUTING_LOG_CAPACITY = 200;

/** What happened to a request the proxy tried to route. */
export type PoolRoutingOutcome = 'served' | 'failed';

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
  outcome: PoolRoutingOutcome;
  /** Upstream status once headers arrived; `null` when no candidate ever answered. */
  status: number | null;
  /** Time from the proxy receiving the request to response headers — including failed attempts — not the streamed generation, which continues afterwards. */
  durationMs: number;
}

export interface PoolRoutingSummary {
  recorded: number;
  capacity: number;
  served: number;
  failed: number;
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

  /** Newest first, so a UI showing only the first page shows the most recent decisions. */
  list(limit = ROUTING_LOG_CAPACITY): PoolRoutingRecord[] {
    return this.entries.slice(-limit).reverse();
  }

  summary(): PoolRoutingSummary {
    let served = 0;
    let failovers = 0;
    for (const entry of this.entries) {
      if (entry.outcome === 'served') served += 1;
      if (entry.failedOverFrom.length > 0) failovers += 1;
    }
    return {
      recorded: this.entries.length,
      capacity: ROUTING_LOG_CAPACITY,
      served,
      failed: this.entries.length - served,
      failovers,
      lastAt: this.entries[this.entries.length - 1]?.at ?? null,
    };
  }
}
