import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';
import type { PoolPinMode, PoolPinScope, PoolPinTargetKind } from '@/common/helpers/hub-pool';

/**
 * The default ring size, and the default page `GET routing-log` returns when no `limit` is given.
 *
 * Kept as the default page even when `HUB_POOL_ROUTING_LOG_SIZE` raises the ring: the dashboard polls
 * this route every 15 s without a limit, and a row is ~540 bytes of JSON, so serving a 10,000-row
 * ring by default would put 5 MB on every poll. A caller that wants more asks for it.
 */
export const ROUTING_LOG_CAPACITY = 200;

/**
 * Largest ring `HUB_POOL_ROUTING_LOG_SIZE` may ask for. Measured: a settled outbound row with usage
 * and a one-hop failover is 539 bytes of JSON and ~0.8 KB of heap, so 10,000 rows is ~8 MB — enough
 * for a fleet QA run to page an hour of agent traffic, and small enough that a typo cannot make the
 * Hub hold hundreds of megabytes of metadata.
 */
export const MAX_ROUTING_LOG_CAPACITY = 10_000;

/**
 * The ring size for this process, from `HUB_POOL_ROUTING_LOG_SIZE`.
 *
 * Never below the default: 200 rows is already under 200 KB, so a smaller ring saves nothing worth
 * having, and it would silently stop the dashboard's "window may be partial" caveat (which fires at
 * a full 200-row page) from ever appearing. Anything unparseable is the default, not an error — this
 * is read once at boot, and a Hub that refused to start over an observability knob would be worse
 * than one that ignored it.
 */
export function resolveRoutingLogCapacity(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed)) {
    return ROUTING_LOG_CAPACITY;
  }
  return Math.min(MAX_ROUTING_LOG_CAPACITY, Math.max(ROUTING_LOG_CAPACITY, Math.floor(parsed)));
}

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
  /**
   * The request's id, and the value of `X-Hub-Pool-Request-Id` on its response.
   *
   * On an `outbound` row this Hub minted it; on an `inbound` row it is the id the sending peer
   * minted for the same request, carried on the `/local/*` forward, so the two nodes' rows for one
   * call join on equality. Before this, fleet QA attributed an agent turn's calls by matching rows
   * to a time window on the entry Hub's clock, which cannot tell two concurrent calls for the same
   * model apart. An inbound row from a peer that sent no usable id gets a fresh one here: it still
   * needs a key, and an older peer is the normal case in a mixed-version fleet.
   */
  id: string;
  at: string;
  /**
   * When anything on this row last changed: placement, a failover moving it to the next candidate,
   * settling, or usage arriving. `?since=` filters on this rather than `at`, because the row a
   * poller most needs to see again is the one it last saw `pending` — placed minutes before it
   * settles, so a cursor on `at` would never return it.
   */
  updatedAt: string;
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
  /**
   * What the prompt ceiling did to this decision, or `null` when no candidate had a ceiling at all.
   *
   * The pin's twin, for the same question: when a long prompt skips fzzy, an operator has to be able
   * to tell "its ceiling excluded it" from "the ranker preferred another node". Present (with an
   * empty `excluded`) whenever some candidate carried a ceiling, so the estimate is visible for the
   * requests that stayed under it too. Always `null` on `inbound` rows — the ceiling is applied by
   * the node that chooses, and a peer's forward is never re-routed.
   */
  promptCeiling: PoolRoutingPromptCeiling | null;
  /**
   * What measured prefill rates did to this decision, or `null` when no candidate had a measurement
   * that applies to a prompt this size — which is every request on a fleet nothing has been timed on.
   * The ceiling's twin for the automatic case: it answers "why did the long turn skip fzzy" with the
   * numbers. Always `null` on `inbound` rows, for the same reason.
   */
  throughput: PoolRoutingThroughput | null;
  /**
   * What prefix affinity did to this decision, or `null` when affinity is off
   * (`poolPrefixAffinityMaxInFlight: 0`), the route is not one it judges, or the body had nothing to
   * key on. The third companion to `pin` and `promptCeiling`: when every turn of an agent session
   * lands on one node, an operator has to be able to tell "it followed its prefix" from the ranker
   * or a pin deciding the same thing — and when a turn re-prefilled cold, whether affinity missed,
   * stood aside for a queue, or was overruled. Always `null` on `inbound` rows, like the others.
   */
  affinity: PoolRoutingAffinity | null;
  /**
   * What slot-aware placement did to this decision, or `null` when it is off
   * (`poolSlotAwareness: 0`) or no candidate advertised a slot count. The fourth companion: when a
   * burst lands on the 4-slot nodes and skips a 2-slot node that scored better, an operator has to be
   * able to tell "its slots were full" from the ranker or a pin. Present (with an empty `demoted`)
   * whenever some candidate carried a slot count, so the figures are visible for the requests that
   * found a free slot too. Always `null` on `inbound` rows, like the others.
   */
  slots: PoolRoutingSlots | null;
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
  /**
   * Whether the request asked for a streamed response — which decides what its deadline measures:
   * the wait for the first frame, or the whole completion. `null` on a row recorded before the body
   * was looked at: an `auto` this Hub could not resolve, or a peer forward refused at the door.
   */
  stream: boolean | null;
  /**
   * UTF-8 size of the request body as forwarded. The first-byte budget is sized from the prompt, so
   * without this a 900 s wait and a 300 s wait look like the same kind of row. `null` as for `stream`.
   */
  bodyBytes: number | null;
  /**
   * The header deadline this request was given, in ms, computed by the same function the forward's
   * timer uses — so a row that failed at exactly this number failed on the deadline, not the network.
   * `null` as for `stream`.
   */
  budgetMs: number | null;
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

/**
 * What a caller hands `record()`/`open()`. The service owns `updatedAt` and mints `id` when none is
 * given; the request-shape fields default to `null`, so a path that has no body to describe (a
 * refusal, an unresolvable alias) does not have to invent one.
 */
export type PoolRoutingRecordInput = Omit<PoolRoutingRecord, 'id' | 'updatedAt' | 'stream' | 'bodyBytes' | 'budgetMs'> &
  Partial<Pick<PoolRoutingRecord, 'id' | 'stream' | 'bodyBytes' | 'budgetMs'>>;

/** The prompt-ceiling half of a routing decision. Sizes and node names only — never any of the prompt it measured. */
export interface PoolRoutingPromptCeiling {
  /** bytes / 4 of the forwarded payload: the same estimate `firstByteBudgetMs` sizes the header wait from. */
  estimatedTokens: number;
  /**
   * Nodes whose ceiling was below the estimate, in ranked order; `'local'` for this node. They were
   * moved behind every node under its ceiling, not removed, so failover can still reach them.
   */
  excluded: PoolRoutingCeilingExclusion[];
  /**
   * `true` when the request was placed on one of those nodes anyway: every candidate was over its
   * ceiling, or every candidate under one failed first. A slow answer beats none.
   */
  overridden: boolean;
}

export interface PoolRoutingCeilingExclusion {
  node: string;
  maxPromptTokens: number;
}

/** The throughput half of a routing decision. Rates, sizes and node names only. */
export interface PoolRoutingThroughput {
  /** bytes / 4 of the forwarded payload, as for the ceiling and the budget. */
  estimatedTokens: number;
  /** The deadline this request was placed under: the header wait if streamed, the whole completion otherwise. */
  budgetMs: number;
  /** Every candidate with applicable evidence, in ranked order. Unmeasured candidates are absent: they kept their place. */
  estimates: PoolRoutingThroughputEstimate[];
  /**
   * `true` when the request was placed on a `slow` candidate anyway: every candidate was predicted to
   * miss the budget, or every one that was not failed first.
   */
  overridden: boolean;
}

export interface PoolRoutingThroughputEstimate {
  node: string;
  backend: InferenceBackendType;
  /** The rate as measured, before any growth: comparable with the engine's own figure. */
  tokensPerSec: number;
  /** The prompt size that measurement was taken at. */
  fromPromptTokens: number;
  /** `true` when a smaller measurement was read forward to this prompt's size, so `predictedMs` includes the growth factor. */
  extrapolated: boolean;
  /** Time to a first byte this node is expected to need for a prompt this size. */
  predictedMs: number;
  /** `observed`: this Hub timed it. `advertised`: the node reported it. The slower of the two is used. */
  source: 'observed' | 'advertised';
  /** The evidence is a request that ran out of its deadline, so `predictedMs` is a lower bound. */
  deadline: boolean;
  /** Predicted to miss `budgetMs`, so moved behind every candidate that was not. */
  slow: boolean;
}

/**
 * The prefix-affinity half of a routing decision. Node names and counts only — never the session
 * key, which is either an app's own identifier or a digest of its prompt.
 */
export interface PoolRoutingAffinity {
  /** Where the key came from: the app's `X-Hub-Pool-Session` header, or a digest of the prompt's head. */
  key: 'header' | 'hashed';
  /**
   * `hit`: the remembered node was under the limit and is the first candidate. `skipped`: it is a
   * candidate but was not placed first — at or over `maxInFlight` when `inFlight >= maxInFlight`,
   * otherwise displaced by a later step (a ceiling, a throughput demotion, or a pin). `miss`: nothing
   * is remembered for this prefix, or the remembered node and engine can no longer serve the model.
   */
  outcome: 'hit' | 'miss' | 'skipped';
  /** The node remembered for this prefix, `'local'` for this one; `null` when nothing was. */
  remembered: string | null;
  /** The remembered node's queue depth at the decision, `null` when it was not a candidate. */
  inFlight: number | null;
  /** The `poolPrefixAffinityMaxInFlight` in force, counting the request being placed. */
  maxInFlight: number;
}

/**
 * The slot-awareness half of a routing decision. Node names and counts only.
 */
export interface PoolRoutingSlots {
  /**
   * Candidates whose known queue depth had reached their advertised slots, in ranked order;
   * `'local'` for this node. They were moved behind every candidate with a free slot, not removed,
   * so failover can still reach them.
   */
  demoted: PoolRoutingSlotDemotion[];
  /**
   * `true` when the request was placed on one of those anyway: every candidate was full, every one
   * with a free slot failed first, or a prompt ceiling put every free one behind it. A queued
   * answer beats none.
   */
  overridden: boolean;
}

export interface PoolRoutingSlotDemotion {
  node: string;
  backend: InferenceBackendType;
  /** The queue depth the ranker knew at the decision — the same figure it sorted on. */
  inFlight: number;
  /** The slot count the node advertised. */
  slots: number;
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
  /**
   * Placement time of the oldest row still in the ring. A poller whose cursor is older than this may
   * have missed rows: the ring evicts by placement, silently.
   */
  oldestAt: string | null;
  /** Rows recorded since this process started, evicted or not. `totalRecorded - recorded` is how many the ring has dropped. */
  totalRecorded: number;
  /**
   * Random per process. The log is in memory, so a restart empties it; a poller that sees this change
   * knows its cursor now points into a different log, rather than reading "no new rows" as "no traffic".
   */
  bootId: string;
  /** When this process's log began. */
  startedAt: string;
}

/** One page of the log plus what a poller needs to ask for the next one. */
export interface PoolRoutingQueryResult {
  /** Newest placement first, at most `limit` rows. */
  entries: PoolRoutingRecord[];
  /**
   * How many rows matched `since` before `limit` cut the page. `matched > entries.length` means the
   * page is truncated. With `since`, what was left out is the NEWER changes, and `nextSince` resumes
   * at them; without it, what was left out is older placements, which a caller asking for "the
   * latest" did not want.
   */
  matched: number;
  /**
   * Pass it back as `since`. With `since`, the largest `updatedAt` on this page; without, the largest
   * in the whole ring, so a first call can start tailing from now. `since` is inclusive, so the row
   * carrying it comes back once more; take the newest copy of each `id`. Inclusive because a row can
   * change twice inside one millisecond (settled, then usage attached), and an exclusive cursor would
   * lose the second change. `null` when nothing matched: keep the cursor you had.
   *
   * A full page whose `nextSince` equals the `since` you sent means more than `limit` rows changed in
   * that one millisecond; the cursor cannot move past them until you ask with a larger `limit`.
   */
  nextSince: string | null;
}

/** The latest `updatedAt` among `rows`, or `null` for none. */
function latestUpdatedAt(rows: readonly PoolRoutingRecord[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (latest === null || Date.parse(row.updatedAt) > Date.parse(latest)) {
      latest = row.updatedAt;
    }
  }
  return latest;
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
 * worth, and a routing decision has no value once the process that made it is gone. `bootId` and
 * `startedAt` exist so that a reader can at least tell a restart apart from a quiet pool.
 */
@Injectable()
export class HubPoolRoutingLogService {
  private readonly entries: PoolRoutingRecord[] = [];
  private readonly capacity = resolveRoutingLogCapacity(process.env.HUB_POOL_ROUTING_LOG_SIZE);
  private readonly bootId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private totalRecorded = 0;

  /** Append a finished row. Returns the stored row, so a caller can answer with its `id`. */
  record(entry: PoolRoutingRecordInput): PoolRoutingRecord {
    const row: PoolRoutingRecord = {
      stream: null,
      bodyBytes: null,
      budgetMs: null,
      ...entry,
      id: entry.id ?? randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    this.entries.push(row);
    this.totalRecorded += 1;
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return row;
  }

  /**
   * Record a request the moment it is placed, as `pending`, and hand back the row so the proxy can
   * keep it current through failovers and settle it when headers arrive. The row is the same object
   * the ring holds, so every later `list()` reflects the update without a second entry — a request
   * that fails over three times is still one line, as before. If the ring has already evicted the
   * row by the time it settles, the mutation is harmless.
   */
  open(entry: Omit<PoolRoutingRecordInput, 'outcome' | 'status' | 'durationMs' | 'usage'>): PoolRoutingRecord {
    return this.record({ ...entry, outcome: 'pending', status: null, durationMs: null, usage: null });
  }

  /**
   * Change a row that is still `pending` — the proxy moving it to its next candidate. Through here
   * rather than `Object.assign` on the row so `updatedAt` moves with it: a poller watching a long
   * failover walk sees each hop, not just the last.
   */
  update(row: PoolRoutingRecord, patch: Partial<Omit<PoolRoutingRecord, 'id' | 'updatedAt'>>): void {
    Object.assign(row, patch);
    row.updatedAt = new Date().toISOString();
  }

  /** Move a row out of `pending`. Fields not given keep what the placement wrote. */
  settle(row: PoolRoutingRecord, patch: Partial<Omit<PoolRoutingRecord, 'id' | 'updatedAt'>> & { outcome: 'served' | 'failed' }): void {
    this.update(row, patch);
  }

  /**
   * Attach token usage once the backend's response finishes, well after `settle()` already
   * recorded the outcome at headers time. Same object-reference mutation as `settle()`, and the
   * same tolerance for a row the ring has already evicted — a slow generation can outlive its own
   * row's place in the buffer, and that is not a bug in this method.
   */
  attachUsage(row: PoolRoutingRecord, usage: PoolRoutingUsage): void {
    this.update(row, { usage });
  }

  /** Newest first, so a UI showing only the first page shows the most recent decisions. */
  list(limit = ROUTING_LOG_CAPACITY): PoolRoutingRecord[] {
    return this.query({ limit }).entries;
  }

  /**
   * A page of the log, optionally only the rows placed or changed at or after `since`.
   *
   * `since` is compared as a time, not as a string, so a caller may send any ISO form (an offset
   * rather than `Z`, no milliseconds). An unparseable `since` is rejected by the DTO before this runs.
   */
  query(options: { limit?: number; since?: string } = {}): PoolRoutingQueryResult {
    const limit = options.limit ?? ROUTING_LOG_CAPACITY;
    if (options.since === undefined) {
      return { entries: this.entries.slice(-limit).reverse(), matched: this.entries.length, nextSince: latestUpdatedAt(this.entries) };
    }
    const sinceMs = Date.parse(options.since);
    const matching = this.entries.filter((entry) => Date.parse(entry.updatedAt) >= sinceMs);
    // A cursor page that `limit` cuts keeps the OLDEST changes and leaves the newer ones for the next
    // call. Cutting by newest placement, as the page without a cursor does, and then handing back the
    // newest `updatedAt` of everything matched, made a poller that follows `nextSince` skip every row
    // the cut dropped: a burst of 500 rows between two `limit=200` polls lost 300 of them, while
    // `matched` said 500 and nothing else did. Stable sort, so rows that changed in the same
    // millisecond keep placement order and the ones past the cut come back next time (`since` is
    // inclusive).
    let page = matching;
    if (matching.length > limit) {
      const kept = new Set([...matching].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).slice(0, limit));
      page = matching.filter((entry) => kept.has(entry));
    }
    return { entries: [...page].reverse(), matched: matching.length, nextSince: latestUpdatedAt(page) };
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
      capacity: this.capacity,
      served,
      failed: this.entries.length - served - pending,
      pending,
      failovers,
      lastAt: this.entries[this.entries.length - 1]?.at ?? null,
      oldestAt: this.entries[0]?.at ?? null,
      totalRecorded: this.totalRecorded,
      bootId: this.bootId,
      startedAt: this.startedAt,
    };
  }
}
