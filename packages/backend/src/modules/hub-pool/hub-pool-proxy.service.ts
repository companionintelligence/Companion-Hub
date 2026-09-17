import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Response } from 'express';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  CAPABILITIES_FRESHNESS_POLLS,
  UNKNOWN_PRESSURE,
  clampPromptCeiling,
  effectivePeerPressureBand,
  inventoryListsModel,
  isCapabilitiesSnapshotFresh,
  resolveHubPoolDirections,
  resolvePinFor,
  resolvePoolMaxPromptTokens,
  type HubPoolDirectionalState,
  type HubPoolPin,
} from '@/common/helpers/hub-pool';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from './hub-pool-load.service';
import {
  HubPoolRoutingLogService,
  type PoolRoutingCeilingExclusion,
  type PoolRoutingOutcome,
  type PoolRoutingPin,
  type PoolRoutingPromptCeiling,
  type PoolRoutingUsage,
} from './hub-pool-routing-log.service';
import { HubPoolPressureService } from './hub-pool-pressure.service';
import { injectUsageOptIn, tapResponseUsageWhileStreaming } from './response-usage-tap';
import { chooseAutoModel, collectPoolModelOffers, type AutoModelPreference, type NodeModelInventory } from './pool-auto-model';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { PoolCandidate, PoolPeerCapabilities } from './hub-pool.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Header-wait budget for a forwarded STREAMED request. Cleared as soon as the upstream responds, so
 * it never caps how long a streamed generation may run — but for an engine that streams, the first
 * byte comes only after the model is loaded AND the prompt is evaluated, and that is not "well under
 * a second" for an agent turn. Measured on beta-max, 2026-09-15: a 150 KB prompt (OpenClaw's first
 * turn is 162 KB — system prompt, every tool schema, history) into a cold `qwen3.6:27b` took
 * **131.8 s** to its first byte over the direct engine path, 0.97 s once the prompt was cached. At
 * the old 15 s every such turn was abandoned here, failed over to a peer that then needed the same
 * two minutes, and reported as "unreachable" — the routing log showed 15123 ms, 15129 ms, node
 * `null`. Five minutes by default, like the completion budget below, and env-overridable for the
 * same reason: the right number is a property of the operator's hardware. A dead peer is still
 * caught quickly — a refused TCP connect fails at once, and the health poll marks a silent one
 * unreachable after three misses — this only stops a *slow* engine reading as a dead one.
 */
const CONNECT_TIMEOUT_MS = Math.max(15_000, Number(process.env.HUB_POOL_FIRST_BYTE_TIMEOUT_MS) || 300_000);

/**
 * The slowest prompt-evaluation rate a placed request is budgeted against, in tokens per second.
 *
 * A fixed first-byte budget is wrong for a streamed request whose prompt the engine has to READ
 * before it can say anything, because that cost scales with the prompt. On beta-max, Ollama's own
 * log for an OpenClaw turn: 47,104 prompt tokens at 192 → 157 tok/s (it slows as the context
 * grows), 98% evaluated at 296.8 s — and at 300 s the fixed budget cancelled it, five minutes of
 * GPU work were discarded, and the request moved to a peer that then started the same prefill from
 * zero, cold. So the budget is sized from the body: tokens ≈ bytes / 4, divided by this floor rate,
 * never below the fixed budget. 50 tok/s is below every GPU node measured on this fleet (157–312)
 * and above the CPU-bound ones (27–37), which is the point: a node that slow reads as failed and
 * the work moves, a node merely working through a big prompt does not.
 */
const MIN_PREFILL_TOKENS_PER_SEC = Math.max(1, Number(process.env.HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC) || 50);

/**
 * The prompt-size estimate every pool decision uses: tokens ≈ bytes / 4 of the forwarded payload.
 *
 * One function, because two decisions now hang on it — how long to wait for a first byte, and
 * whether a node's prompt ceiling excludes it — and if they estimated differently a request could be
 * sent to a node as "under its ceiling" and then budgeted as though it were far larger. Coarse on
 * purpose: it counts the JSON envelope and tool schemas along with the prose, which is what the
 * engine has to read too.
 */
export function estimatePromptTokens(bodyBytes: number): number {
  return Math.ceil(bodyBytes / 4);
}

/** Header-wait budget for a streamed request carrying `bodyBytes` of prompt. Exported for the doctor and tests. */
export function firstByteBudgetMs(bodyBytes: number): number {
  return Math.max(CONNECT_TIMEOUT_MS, Math.ceil(estimatePromptTokens(bodyBytes) / MIN_PREFILL_TOKENS_PER_SEC) * 1000);
}

/** The body exactly as it goes on the wire to an engine or a peer, which is what both prompt-size decisions measure. */
function forwardedPayload(method: string, body: unknown): string | undefined {
  return method === 'GET' ? undefined : JSON.stringify(body);
}

/**
 * The pooled routes a prompt ceiling applies to: the ones whose body is one context the engine
 * prefills before its first token, which is the cost that grows with length on a CPU node.
 *
 * Embeddings are left out on purpose. A batch is many short inputs, each capped by the embedding
 * model's own context, so its byte count measures how much work the batch is and says nothing about
 * the per-sequence prefill fzzy was measured slowing on. Applying the ceiling there would move bulk
 * indexing off a node for a cost it does not have. An allowlist rather than a denylist, so a route
 * added later routes as it did before ceilings until someone decides it should be judged.
 */
const PROMPT_CEILING_PATHS: ReadonlySet<string> = new Set(['/v1/chat/completions', '/v1/completions', '/api/chat', '/api/generate']);

/**
 * Budget for a NON-STREAMED completion, which is a different thing from a connect budget.
 *
 * `CONNECT_TIMEOUT_MS` guards the wait for response headers, and for a streamed request that is
 * the wait for the first frame (see its own note on how long that can be). For a
 * non-streamed request the upstream sends no headers at all until the entire completion is ready, so
 * the same timer silently becomes a cap on TOTAL GENERATION TIME. Fifteen seconds of generation is
 * a short prompt; every real coding task, long summary or agent turn is longer, and every one of
 * them was aborted and reported to the caller as an unreachable node.
 *
 * Proven on the fleet, same node, same model, back to back:
 *   direct  :11434  -> HTTP 200 in 33.9s
 *   pool    :5002   -> HTTP 502 in 15.03s, "All pool nodes serving model ... are unreachable"
 * A 12s generation through the pool succeeded, and a cold model load — the likelier suspect —
 * succeeded in 4.6s with nothing resident. It is specifically generations past the deadline.
 *
 * Five minutes by default because that is comfortably past the worst decode this fleet produces
 * (a 2600-token generation on its slowest node measured ~300s), and env-overridable because the
 * right number is a property of the operator's hardware, not of this file.
 */
const COMPLETION_TIMEOUT_MS = Math.max(CONNECT_TIMEOUT_MS, Number(process.env.HUB_POOL_COMPLETION_TIMEOUT_MS) || 300_000);

/**
 * The dispatcher every pool forward is sent through: Node's OWN bundled undici `Agent`, with its
 * header timer switched off so the budgets above are the only header deadlines.
 *
 * Without it, every budget in this file above five minutes was fiction. `fetch` in Node is undici,
 * and undici's default Agent gives up waiting for response headers after 300 s (`headersTimeout`) —
 * independently of, and before, any AbortController deadline set here. Measured on the fleet,
 * 2026-09-17: a 184 KB streamed turn (~46k tokens) placed on fzzy, which serves qwen3-coder:30b on
 * CPU at ~123 tok/s prefill, carried a body-sized budget of 922 s from `firstByteBudgetMs` and failed
 * at 300.8 s with "fetch failed" (cause UND_ERR_HEADERS_TIMEOUT) — the incident #1463 exists to
 * prevent, still happening one layer down, and reported as a transport failure rather than a
 * deadline. The same turn on a GPU node passed in 268 s, under the cap, which is why it hid.
 * `HUB_POOL_FIRST_BYTE_TIMEOUT_MS` and `HUB_POOL_COMPLETION_TIMEOUT_MS` above 300 s were silently
 * capped the same way.
 *
 * Why the bundled class rather than the `undici` package: a userland undici's Agent is not
 * guaranteed to interoperate with the fetch Node ships (different majors disagree on the dispatcher
 * protocol), and adding it means a second HTTP stack in the image. Node's fetch installs its Agent as
 * the global dispatcher under the well-known cross-version symbol `undici.globalDispatcher.1` the
 * first time `fetch` is touched; its constructor is exactly the class `fetch` expects.
 *
 * `bodyTimeout` keeps undici's default: it is the idle gap between body chunks, which a healthy
 * stream never approaches, and it is the only guard against an upstream that stalls mid-stream.
 *
 * Returns null — and forwards fall back to the default dispatcher, with the 300 s cap — when the
 * global dispatcher is not a plain Agent (e.g. an operator installed a ProxyAgent), rather than
 * replacing someone's proxy configuration with a direct connection.
 */
type PoolDispatcher = { dispatch: (...args: never[]) => unknown };
let poolDispatcherMemo: PoolDispatcher | null | undefined;
export function poolFetchDispatcher(): PoolDispatcher | null {
  if (poolDispatcherMemo !== undefined) return poolDispatcherMemo;
  poolDispatcherMemo = null;
  try {
    void globalThis.fetch; // loading Node's fetch installs its global dispatcher
    const installed = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('undici.globalDispatcher.1')] as
      | { constructor?: new (options: { headersTimeout: number }) => PoolDispatcher }
      | undefined;
    const AgentClass = installed?.constructor;
    if (typeof AgentClass === 'function' && AgentClass.name === 'Agent') {
      poolDispatcherMemo = new AgentClass({ headersTimeout: 0 });
    }
  } catch {
    poolDispatcherMemo = null;
  }
  return poolDispatcherMemo;
}

/** Test seam: forget the memoised dispatcher. */
export function resetPoolFetchDispatcherForTests(): void {
  poolDispatcherMemo = undefined;
}

/** Does this body ask for a streamed response? Decides which of the two budgets applies. */
export function isStreamingRequest(body: unknown): boolean {
  return !!(body && typeof body === 'object' && (body as { stream?: unknown }).stream === true);
}

/**
 * What to tell a caller when every candidate failed.
 *
 * The single sentence this replaces — "All pool nodes serving model X are currently unreachable" —
 * was emitted for every cause, and it is wrong for the most common one. A node that is merely SLOW
 * trips `CONNECT_TIMEOUT_MS` and gets reported as unreachable, which sends the operator to look at
 * networking, pairing and inventory while the actual node is sitting there answering its own engine
 * fine on the direct path.
 *
 * Measured on this fleet: five 502s in one run, every one on the pool transport, landing at 15017ms
 * and 15020ms on one node and ~11050ms on another — variance of milliseconds against a fixed
 * deadline. Both nodes served the identical request over the direct path in the same run. The proxy
 * had not established that anything was unreachable; it had established that nothing answered
 * within its own budget, which is a different claim and points at a different fix.
 *
 * So: name the deadline when we hit it, and say plainly that the node may be healthy and slow.
 */
/** JSON for a log line, never throwing on a cycle or a BigInt. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) ?? '';
  } catch {
    return '[unserialisable error value]';
  }
}

export function describeAllCandidatesFailed(model: string, candidates: number, lastError: unknown): string {
  // `String(someObject)` is "[object Object]", which tells the operator nothing and hides the one
  // field that would have. A rejected value here is not always an Error — a fetch layer can reject
  // with a plain object carrying `code`/`errno` — so serialise those rather than stringifying them.
  const message =
    lastError instanceof Error ? lastError.message : lastError == null ? '' : typeof lastError === 'object' ? safeJson(lastError) : String(lastError);
  // Two deadlines now produce a timeout, and both must be recognised here: the header wait on a
  // streamed request, and the completion budget on a non-streamed one. Matching only the first would
  // send every long-generation abort down the generic branch and print a raw abort message instead
  // of the sentence that tells an operator this is a deadline rather than a dead node.
  // A header timeout from undici itself (UND_ERR_HEADERS_TIMEOUT) is a deadline too — it is what a
  // forward hits if `poolFetchDispatcher` could not be installed, and it surfaces as "fetch failed"
  // with the code only on `cause`.
  const cause = lastError instanceof Error ? (lastError as Error & { cause?: { code?: unknown } }).cause : undefined;
  const undiciHeaderTimeout = cause?.code === 'UND_ERR_HEADERS_TIMEOUT' || /UND_ERR_HEADERS_TIMEOUT|Headers Timeout Error/.test(message);
  const timedOut = undiciHeaderTimeout || /No (?:response headers|completion) within \d+ms/.test(message) || /abort/i.test(message);
  const plural = candidates === 1 ? 'candidate' : 'candidates';
  if (timedOut) {
    return (
      `No pool candidate answered for model "${model}" within its deadline (${candidates} ${plural} tried; ` +
      `${describeAppliedDeadline(message, undiciHeaderTimeout)}). This is a deadline, not proof the nodes are down — ` +
      'a node loading weights, reading a long prompt slowly or serving a long queue hits it while remaining healthy.'
    );
  }
  return `All ${candidates} pool ${plural} for model "${model}" failed${message ? `: ${message}` : '.'}`;
}
/**
 * Which deadline actually expired, in the terms an operator can act on.
 *
 * The message used to print the two FIXED settings — "300000ms for headers on a streamed request" —
 * whatever the request had really been given. Since #1463 a streamed request's header budget is sized
 * from its prompt, so a 184 KB agent turn gets 922 s, and after #1478 it really waits that long; the
 * old sentence then told the operator the proxy gave up at 300 s and pointed at a setting that was not
 * the one that decided it. Measured on fzzy 2026-09-17: cancelled at 922.0 s, message said 300000ms.
 *
 * The budget that applied is in the abort reason (`fetchWithConnectTimeout` writes it), so it is read
 * from there rather than recomputed from settings that may not describe this request.
 */
export function describeAppliedDeadline(message: string, undiciHeaderTimeout: boolean): string {
  const applied = /No (response headers|completion) within (\d+)ms/.exec(message);
  if (applied) {
    const ms = Number(applied[2]);
    if (applied[1] === 'completion') {
      return (
        `the last waited ${ms}ms for a whole non-streamed completion — HUB_POOL_COMPLETION_TIMEOUT_MS, ` +
        'or the prompt-sized budget when that is longer'
      );
    }
    if (ms > CONNECT_TIMEOUT_MS) {
      return (
        `the last waited ${ms}ms for response headers — a budget sized from the prompt at a floor of ` +
        `${MIN_PREFILL_TOKENS_PER_SEC} tok/s (HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC), so a node that cannot read ` +
        'this prompt that fast is treated as failed and the work can move to a faster one'
      );
    }
    return `the last waited ${ms}ms for response headers — HUB_POOL_FIRST_BYTE_TIMEOUT_MS`;
  }
  if (undiciHeaderTimeout) {
    return (
      "Node's fetch stopped waiting for response headers at its own 300000ms limit (undici headersTimeout) " +
      "because the pool's uncapped dispatcher is not installed — pool budgets above that cannot take effect"
    );
  }
  return 'the request was aborted before any response headers arrived';
}

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade']);

/**
 * The local-only routes an Ollama-native client probes to decide whether this proxy speaks
 * Ollama's native protocol before it will use it — see the `warn` log in
 * {@link PoolProxyService.proxyLocalOnlyRequest} for why exhausting local backends on one of
 * these specifically deserves louder logging than any other local-only path.
 */
const NATIVE_CAPABILITY_PROBE_PATHS = new Set(['/api/version', '/api/tags']);

// ── Serving-node attribution ────────────────────────────────────────────────
//
// Which node ran a routed request used to be knowable only from the routing log — session-gated,
// in-memory, gone on restart — so proving cross-node routing on the fleet meant checking `ollama ps`
// residency on the far side. The decision is stated on the response instead. The values are chosen so
// nothing crosses a boundary it has not already crossed:
//   - the peer's tailnet FQDN is what this Hub holds in its peer row, and the routes carrying it are
//     `PoolAppGuard`-gated to apps inside this appliance, which are already trusted to spend that
//     peer's GPU time;
//   - a request this node served itself says `local`, never this node's own MagicDNS name. `identify`
//     deliberately stopped disclosing that name to unauthenticated callers, and the proxy is an
//     unauthenticated (origin-checked) surface, so the local case keeps the routing log's `NODE local`
//     rather than opening a second door to the same datum;
//   - the backend is the engine TYPE (`ollama`, `vllm`, …), never a container name; the model is the
//     one the caller asked for. The peer's node UUID is a durable correlator and is never here — which
//     is why the header is not `X-Hub-Pool-Node`: that name carries the UUID on the signed *request*
//     path, and reusing it for a response would invite someone to "fix" the value to match.
//
// `X-Hub-Pool-Backend` / `X-Hub-Pool-Model` are the names this proxy already sends a peer on the
// forwarded request, with the same meaning, so one vocabulary covers both directions of the wire.

/** Response header naming the node whose engine served a routed request: {@link POOL_SERVED_LOCALLY} or the peer's tailnet FQDN. */
export const POOL_SERVED_BY_HEADER = 'X-Hub-Pool-Served-By';
/** Request → peer and response → caller: which of the serving node's engines ran the request. */
export const POOL_BACKEND_HEADER = 'X-Hub-Pool-Backend';
/** Request → peer and response → caller: the model the request was routed for. */
export const POOL_MODEL_HEADER = 'X-Hub-Pool-Model';
/**
 * {@link POOL_SERVED_BY_HEADER}'s value when this node's own engine served the request. Shares the
 * routing log's key on purpose, and can never collide with a peer: `normalizePeerFqdn` admits only
 * names of two or more labels, so no peer row is ever the bare word `local`.
 */
export const POOL_SERVED_LOCALLY = LOCAL_CANDIDATE_KEY;
/**
 * Every `x-hub-pool-*` header on an UPSTREAM response is dropped before this Hub's own attribution
 * is set. Attribution is this Hub's statement about the routing decision it made; a peer's `/local/*`
 * answer (or, one day, a backend) must not be able to pose as it, and a peer that stamped its own
 * view would be right from where it stands and wrong from where the caller does.
 */
const POOL_HEADER_PREFIX = 'x-hub-pool-';

/** The attribution headers for a response served by `candidate`. Pure, so the contract has its own test. */
export function servedByHeaders(candidate: PoolCandidate, model: string): Record<string, string> {
  return {
    [POOL_SERVED_BY_HEADER]: candidate.nodeFqdn ?? POOL_SERVED_LOCALLY,
    [POOL_BACKEND_HEADER]: candidate.backend,
    [POOL_MODEL_HEADER]: model,
  };
}
/** 4xx that means "this node can't serve you", never "your request is bad" — retryable on any candidate. */
const TRANSPORT_4XX = new Set([408, 429]);
/**
 * Additionally retryable when the candidate is a *peer*: everything on this list is the peer's own
 * hop answering about the pairing (PoolPeerGuard 401, not-connected 403, a route the peer's build
 * doesn't have 404), not the application's request being wrong.
 */
const PEER_TRANSPORT_4XX = new Set([401, 403, 404, 408, 429]);

/**
 * Load assumed for a peer whose snapshot is stale, or predates `inFlightRequests` entirely.
 * Deliberately not 0: an unmeasured node must never outrank one we know to be idle. Same
 * neutral-when-stale rule NVIDIA's PAIR applies to its GPU-pressure band.
 */
const UNKNOWN_PEER_LOAD = 1;

/** Hardware classes worth preferring between two equally loaded peers, best first. */
const TIER_RANK = { high: 0, medium: 1, low: 2, 'cpu-only': 3, insufficient: 4 } as const;
/** A tier string this build doesn't recognise (an older or newer peer) ranks with 'low' — unknown is never optimistic. */
const UNKNOWN_TIER_RANK: number = TIER_RANK.low;
/**
 * The local node is never out-ranked on hardware: local-vs-peer is decided entirely by the
 * operator's `poolLocalAffinity` setting, and reading this node's own tier would put a hardware
 * probe on the request path for a value that only breaks ties. At an exact score tie this is also
 * why local wins — a free local node has no hop and a warm cache — which is what `affinity = 0`
 * actually means, as opposed to the "pure least-loaded" the docs used to claim.
 */
const LOCAL_TIER_RANK = -1;

/** A candidate plus the three ordering keys {@link PoolProxyService.buildCandidateList} sorts on. */
interface RankedCandidate {
  candidate: PoolCandidate;
  /** Queue depth, already carrying the local-affinity handicap for peers and the weighted pressure term. Lower is better. */
  score: number;
  /**
   * GPU-pressure band 0-3, with {@link UNKNOWN_PRESSURE} standing in for "unmeasured". Read as a
   * tie-break only, and only when `poolPressureWeight` is non-zero — see the comparator.
   */
  pressure: number;
  tierRank: number;
}

/**
 * Move the pinned node's candidates to the front of an already-ranked list.
 *
 * Three properties, and they are the reason a pin is applied here rather than inside the ranker:
 *
 * 1. **A pin reorders; it never resurrects.** This filters a list that has already been built, so no
 *    pin can re-admit a node that was excluded for a reason: an unreachable or disabled peer (never
 *    in `usablePeers`), a peer whose cached capabilities were dropped after it answered 401/403, a
 *    peer that said `acceptingWork: false`, or a model a local backend has been caught unable to
 *    serve (`unservableModels`). Pinning is a preference over healthy candidates, not a way to force
 *    a request onto a broken engine.
 * 2. **A pin whose target has no candidate is a silent no-op**, not an error: the list comes back
 *    byte-identical, and the request routes exactly as it would with no pin at all. That is what
 *    makes an unreachable pinned node, or one that was unpaired while a pin still names it, a
 *    non-event for inference — the status card is where it is reported, not the request path.
 * 3. **Failover is untouched.** Every other candidate is still behind the pinned one, in the order
 *    the ranker produced, so the pin costs one position rather than the whole failover walk.
 *
 * Pure and exported for its own test: this is the entire behavioural change pinning makes.
 */
export function applyPin(ordered: PoolCandidate[], pin: HubPoolPin | null): PoolCandidate[] {
  if (!pin) {
    return ordered;
  }
  const matches = (candidate: PoolCandidate) => (pin.targetKind === 'local' ? candidate.peerId === null : candidate.peerId === pin.peerId);
  const pinned = ordered.filter(matches);
  // Identity-preserving when nothing matched, so "pinned node cannot serve this" and "no pin" are
  // the same list rather than two code paths that could drift.
  return pinned.length === 0 ? ordered : [...pinned, ...ordered.filter((candidate) => !matches(candidate))];
}

/**
 * Split a ranked list into the candidates under their prompt ceiling (`preferred`) and the ones over
 * it (`overCeiling`), each in the order the ranker produced. The caller places the request on
 * `preferred` and keeps `overCeiling` as the tail of the failover walk.
 *
 * The same shape of decision as {@link applyPin}, and applied just before it, for the same reasons:
 *
 * 1. **It is a preference, not a rule.** An over-ceiling node is moved to the back, never removed.
 *    Removing it would let a ceiling fail a request that succeeds without one: with core-6 answering
 *    503 for the model, a long prompt fails over to fzzy and is answered, where a list without fzzy
 *    has nowhere left to go and returns a 502. When every candidate is over its ceiling nothing
 *    moves at all, and `overridden: true` says so.
 * 2. **It never re-orders within either group.** Both halves keep the ranker's order, so the walk
 *    visits every node it would have, with the ones that asked not to take this prompt last.
 * 3. **Pins apply within each group.** A pin at an over-ceiling node cannot bring a long prompt back
 *    to the front of the walk: the operator said "not the long ones" about that node, and a pin
 *    written for the ordinary case must not quietly override it.
 *
 * Decided on the entry node, from each node's own advertised figure, because only the entry node
 * knows whether there was an alternative. `decision` is `null` when no candidate has a ceiling, so a
 * fleet that never sets one gets the list back untouched and a routing log with nothing to explain.
 *
 * Pure and exported for its own test, like `applyPin`.
 */
export function applyPromptCeiling(
  ordered: PoolCandidate[],
  ceilingOf: (candidate: PoolCandidate) => number | null,
  estimatedTokens: number,
): { preferred: PoolCandidate[]; overCeiling: PoolCandidate[]; decision: PoolRoutingPromptCeiling | null } {
  const ceilings = ordered.map(ceilingOf);
  if (ceilings.every((ceiling) => ceiling === null)) {
    return { preferred: ordered, overCeiling: [], decision: null };
  }
  const preferred: PoolCandidate[] = [];
  const overCeiling: PoolCandidate[] = [];
  const excluded: PoolRoutingCeilingExclusion[] = [];
  for (const [index, candidate] of ordered.entries()) {
    const ceiling = ceilings[index] ?? null;
    if (ceiling === null || estimatedTokens <= ceiling) {
      preferred.push(candidate);
      continue;
    }
    overCeiling.push(candidate);
    // One entry per node: a node with two engines holding the model is still one node that said no.
    const node = candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY;
    if (!excluded.some((entry) => entry.node === node)) {
      excluded.push({ node, maxPromptTokens: ceiling });
    }
  }
  const overridden = preferred.length === 0;
  const decision = { estimatedTokens, excluded, overridden };
  // Identity-preserving when nothing was over or everything was, so both read as "the ranker's list".
  return excluded.length === 0 || overridden ? { preferred: ordered, overCeiling: [], decision } : { preferred, overCeiling, decision };
}

/** The pin, reduced to the metadata the routing log may hold. Never the model or the peer id — the record already carries both. */
export function describePinForLog(pin: HubPoolPin | null): PoolRoutingPin | null {
  return pin ? { scope: pin.scope, mode: pin.mode, targetKind: pin.targetKind } : null;
}

/**
 * The 502 for "nothing can serve this model", said differently when a pin is in force.
 *
 * Worth the extra sentence because a pin is exactly the state an operator sets once and forgets: the
 * unpinned message sends them to look at model inventory, which is right, while the pinned one has
 * to also say that a routing preference is in play — even though, `prefer` being soft, the pin is
 * not what caused this. Deliberately does NOT name the peer: resolving a name here would mean a
 * database read on an error path, and the pin is on the status card either way.
 */
/**
 * The pseudo-model apps send when they want "whatever this Hub's default LLM is". The local router
 * has always accepted it (`InferenceRouterService.resolveAutoModel`); the pool matches engine
 * inventories verbatim and so answered it with `No pool node currently has model "auto"` — the
 * moment a single peer connected, every app on `auto` lost inference. OpenClaw's primary is
 * `ci-hub/auto`, which is how it surfaced. What it resolves to on a pooled route is decided in
 * `pool-auto-model.ts`.
 */
export const AUTO_MODEL = 'auto';

/** What an `auto` request is told when nothing in the pool can stand in for it. */
export function describeUnresolvableAuto(): string {
  return (
    `No chat model on this Hub or its connected peers can stand in for "${AUTO_MODEL}": ` +
    'load a chat model on any pool node, or ask for a model by name.'
  );
}

/**
 * The reason an upstream request is aborted when the app that asked for it has gone.
 *
 * Without it the engine never learns: the upstream `fetch` carried only the proxy's own deadline, so
 * a client that hung up while its turn was still prefilling left the engine prefilling it for nobody.
 * A 47k-token OpenClaw turn is ~300 s of prefill on this fleet's GPU nodes and an engine serves one
 * sequence at a time, so one abandoned turn held the node for five minutes while the retry queued
 * behind it. A streamed body already cancelled on its own once flowing (the pipeline tears down its
 * source); the gap was everything before response headers, on both ends of a pool hop.
 */
const CLIENT_CLOSED_MESSAGE = 'The client closed the connection before the pool response finished';

/**
 * An `AbortSignal` that fires when `res`'s connection closes before the response was finished.
 * Keyed on `writableFinished`, because a response that completed normally closes too. Attach it
 * before the first `await` of a handler, so a client that leaves while candidates are still being
 * ranked is not missed.
 *
 * And keyed on `errored`, because a client leaving is not the only way `res` closes unfinished:
 * when the ENGINE dies mid-stream, `pipeline` destroys `res` with the engine's error, which closes
 * it too. Without that check the catch blocks read their own teardown as a hang-up — measured
 * against a real socket, an engine that dropped its connection mid-generation was logged at debug as
 * "client closed a streaming response", the candidate-failure warning never appeared, and the
 * peer-facing forward swallowed the error instead of surfacing it. A client that disconnects leaves
 * `errored` null: Node closes the response from the socket, not through `destroy(err)`.
 */
function abortWhenClientCloses(res: Response): AbortSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished && !res.errored) controller.abort(new Error(CLIENT_CLOSED_MESSAGE));
  };
  if (res.destroyed) {
    onClose();
  } else {
    // `once`, and never removed: every response closes exactly once, finished or not, so the
    // listener is gone by the time the response is, and after a normal finish it is a no-op.
    res.once('close', onClose);
  }
  return controller.signal;
}

/**
 * Paths that answer ABOUT a model without running it. Their status is no evidence either way about
 * whether the model serves, so it must not feed the serving record: a 200 from `/api/show` would
 * otherwise clear the strikes of a model that fails every generation.
 */
const MODEL_METADATA_PATHS = new Set(['/api/show']);

/**
 * How long a peer gets to START answering a model-metadata lookup before {@link describeFromPeer}
 * moves on to the next peer holding the model.
 *
 * Without its own deadline the lookup inherited the non-streamed request budget, which is sized for a
 * whole completion (COMPLETION_TIMEOUT_MS, 300 s) — so one peer that accepts the connection and then
 * stalls (a wedged model directory, as core-1's once was) held an app's `/api/show` for five minutes
 * per such peer, and OpenClaw gives up on its model long before that. The engine itself is nowhere
 * near that slow: `/api/show` answered in 0.001-0.27 s on core-1, core-7, beta-1, beta-ms-a2 and
 * beta-3-glass (2026-09-17, `qwen3.8:27b` and `minimax-m2:230b`, verbose and not). Headers only: a
 * verbose answer is up to 8 MB (`qwen3.8:27b`), which over a relayed tailnet path may legitimately
 * take longer than this to arrive.
 */
const PEER_MODEL_METADATA_HEADERS_TIMEOUT_MS = 15_000;

export function describeNoCandidates(model: string, pin: HubPoolPin | null): string {
  const base = `No pool node currently has model "${model}" available.`;
  if (!pin) {
    return base;
  }
  const target = pin.targetKind === 'local' ? 'this Hub' : 'a peer';
  const scope = pin.scope === 'model' ? `"${model}" is pinned` : 'Routing is pinned';
  // "either" is load-bearing: a prefer pin never removes a candidate, so the pinned node not being
  // able to serve the model is one fact about an empty list, not the cause of it.
  return `${base} ${scope} to ${target}, which cannot serve it either — the pin only reorders candidates, so this is an inventory problem, not a pin one.`;
}

/**
 * Routes an app-facing inference request to whichever pool node (this one or a
 * connected peer) currently has the requested model, with failover.
 *
 * Local and peer candidates are ranked in ONE list by queue depth, so a saturated
 * local node hands work to an idle peer — the case multi-node pooling exists for.
 * The local node's head start is the explicit, operator-tunable
 * `poolLocalAffinity` setting (`DEFAULT_POOL_LOCAL_AFFINITY`), not an accident of
 * list order.
 *
 * Fails over on a connection error, a header-wait timeout, a 5xx, and the 4xx
 * that describe the *hop* rather than the request (see TRANSPORT_4XX /
 * PEER_TRANSPORT_4XX). A genuine caller 4xx is passed straight through —
 * retrying a malformed request on a different machine just wastes a hop.
 *
 * Failover stops the instant a response is committed: once status and headers
 * have gone to the client, a second candidate has nowhere to write.
 */
@Injectable()
export class PoolProxyService {
  private readonly logger = new Logger(PoolProxyService.name);

  constructor(
    private readonly backends: InferenceBackendRegistry,
    private readonly peerService: HubPoolPeerService,
    /**
     * Retained after the outbound credential moved into `HubPoolPeerService.peerAuthHeaders`, which
     * resolves this node's own name itself. Kept so the positional constructor shape every pool test
     * file builds does not shift for a removal nothing needs.
     */
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for the positional constructor shape (see above)
    private readonly tailscaleService: TailscaleService,
    private readonly loadService: HubPoolLoadService,
    private readonly configuration: ConfigurationService,
    private readonly routingLog: HubPoolRoutingLogService,
    private readonly pressureService: HubPoolPressureService,
    // Appended last, and optional: every pool test file constructs this service positionally, and
    // the `auto` resolution below is the only thing that reads the catalog. Without it `auto` still
    // resolves, on model names alone.
    @Optional() @Inject(forwardRef(() => ModelRegistryService)) private readonly modelRegistry?: ModelRegistryService,
  ) {}

  /**
   * `auto` → the engine id of the chat model the POOL should run it on; any other model unchanged.
   *
   * Resolved against every node that could take the request — this one and each usable peer, by the
   * same predicates candidate ranking applies — and ordered by `chooseAutoModel`: the operator's
   * Settings → Inference model first, then tool-capable, non-tiny, highest-scoring. See
   * `pool-auto-model.ts` for the fleet evidence behind that order. It no longer goes through
   * `InferenceRouterService.resolveAutoModel`, which only ever saw this node, and which, wherever
   * the operator had set nothing, took the registry's pinned or loaded model and then the first one
   * the engine listed — beta-ms-a2's newest pull, `deepseek-r1:8b`.
   */
  async resolveModelAlias(model: string): Promise<string | undefined> {
    if (model !== AUTO_MODEL) {
      return model;
    }
    const [local, peers] = await Promise.all([this.localServableInventory(), this.usablePeers()]);
    const inventories: NodeModelInventory[] = [local, ...peers.map((peer) => this.peerServableInventory(peer))];
    const choice = chooseAutoModel(collectPoolModelOffers(inventories), {
      preferred: this.preferredChatModel(),
      catalog: this.modelRegistry?.getCatalog() ?? [],
    });
    if (choice) {
      this.logger.debug(`[PoolProxy] "${AUTO_MODEL}" resolved to "${choice.model}" (${choice.reason})`);
    }
    return choice?.model;
  }

  /** Settings → Inference, as an engine id. A catalog id maps through its row, an engine id stands as itself. */
  private preferredChatModel(): AutoModelPreference | null {
    const preferredId = this.configuration.getInferencePreferences()?.preferredModel;
    if (!preferredId) {
      return null;
    }
    const curated = this.modelRegistry?.getCuratedModel(preferredId);
    return curated ? { engineId: curated.backendModelId, backend: curated.backend } : { engineId: preferredId };
  }

  /**
   * This node's models as {@link localCandidates} would offer them: healthy, running backends only,
   * minus anything a backend has withheld. The two must agree, or `auto` could resolve to a model
   * that then has no local candidate.
   */
  private async localServableInventory(): Promise<NodeModelInventory> {
    const backends = await Promise.all(
      this.backends.entries().map(async ([type, backend]) => {
        try {
          const health = await backend.healthCheck();
          if (!health.running || !health.healthy) return null;
          return { type, models: health.modelsLoaded.filter((id) => !inventoryListsModel(health.unservableModels, id)) };
        } catch {
          return null;
        }
      }),
    );
    return { local: true, backends: backends.filter((entry): entry is NonNullable<typeof entry> => entry !== null) };
  }

  /** A peer's models as {@link peerCandidates} would offer them: a snapshot that exists, a peer accepting work, healthy backends. */
  private peerServableInventory(peer: HubPoolPeer): NodeModelInventory {
    const capabilities = peer.lastCapabilities as unknown as PoolPeerCapabilities | null;
    if (!capabilities || capabilities.acceptingWork === false) {
      return { local: false, backends: [] };
    }
    return {
      local: false,
      backends: capabilities.backends.filter((backend) => backend.healthy).map((backend) => ({ type: backend.type, models: backend.modelsLoaded })),
    };
  }

  /** Read per request, not cached: a settings PATCH must change routing on the next request, not on the next restart. */
  private localAffinity(): number {
    return this.configuration.getHubPoolPreferences().poolLocalAffinity;
  }

  /** Read per request, like {@link localAffinity}. `0` (the default) takes pressure out of ranking entirely — see {@link buildCandidateList}. */
  private pressureWeight(): number {
    return this.configuration.getHubPoolPreferences().poolPressureWeight;
  }

  /** How old a peer's capability snapshot may be before its self-reported load is discarded, derived from the configured poll cadence so retuning one retunes the other. */
  private capabilitiesFreshnessMs(): number {
    return this.configuration.getHubPoolPreferences().poolHealthPollSeconds * 1000 * CAPABILITIES_FRESHNESS_POLLS;
  }

  /**
   * Read per request, like {@link localAffinity}: flipping a direction must change routing on the
   * next request, not the next restart. Resolved through the shared helper rather than through
   * `HubPoolPeerService`, so there is exactly one place that knows the precedence between the
   * master switch, the two env overrides and the two persisted flags.
   */
  private directions(): HubPoolDirectionalState {
    return resolveHubPoolDirections(this.configuration.getHubPoolPreferences());
  }

  /**
   * Every node that can serve `model`, best first.
   *
   * Local and peer candidates are ranked together. Concatenating them instead — the shape this
   * replaced — made the pool a failover list rather than a balancer: a local backend that merely
   * *had* the model always sorted first, whatever its queue looked like, so the one scenario
   * pooling exists for (this node saturated, a peer idle) could never route away.
   *
   * This is also where the outbound kill switch and the per-peer switch are applied — on the
   * REQUEST path, deliberately not inside `listConnectedPeers()`; see {@link usablePeers}.
   *
   * GPU pressure enters in two places and BOTH vanish at `poolPressureWeight = 0`, which is the
   * shipped default: the weighted term drops out of `score` arithmetically, and the pressure key is
   * not evaluated by the comparator at all. That is why the default is byte-identical to the
   * previous build by construction rather than by an argument about what can be measured — it holds
   * even on a node whose band is a real, moving number.
   *
   * Above zero, a node that cannot measure ranks at {@link UNKNOWN_PRESSURE}, never at 0. This is
   * the invariant the whole feature turns on: most of the fleet cannot measure, and if silence read
   * as "idle" the pool would systematically route to whichever machine knows least about itself.
   *
   * Then the prompt ceilings, when `promptBytes` is given: a node whose ceiling is below the
   * request's estimate moves behind every node that is not, keeping its place in the failover walk —
   * see {@link applyPromptCeiling}.
   *
   * An operator pin is applied LAST, within each of those two groups — see {@link applyPin}. It
   * reorders; it cannot admit a node the steps above excluded.
   */
  async buildCandidateList(model: string, promptBytes?: number): Promise<PoolCandidate[]> {
    return (await this.rankCandidates(model, promptBytes === undefined ? undefined : () => promptBytes)).candidates;
  }

  /**
   * {@link buildCandidateList} plus the pin that shaped the order, for the callers that need to say
   * *why* — the routing log and the 502 message.
   *
   * Split this way rather than having `proxyRequest` re-read the pin: two reads of a settings value
   * that a PATCH can change between them would let the log claim a pin that never applied.
   * `buildCandidateList` stays as the thin wrapper it always was, because it is the shape every
   * candidate-ordering test asserts against.
   */
  private async rankCandidates(
    model: string,
    /**
     * The forwarded payload's size, measured only if some candidate has a ceiling: that is one more
     * serialisation of what can be a 184 KB agent turn, and a fleet with no ceilings should not pay
     * it. Absent means "no body to judge", and the ceiling step is skipped.
     */
    measurePromptBytes?: () => number,
  ): Promise<{ candidates: PoolCandidate[]; pin: HubPoolPin | null; promptCeiling: PoolRoutingPromptCeiling | null }> {
    const [local, peers] = await Promise.all([this.localCandidates(model), this.usablePeers()]);
    const weight = this.pressureWeight();
    const localPressure = this.pressureService.band() ?? UNKNOWN_PRESSURE;
    const localScore = this.loadService.localInFlight() + weight * localPressure;
    const ranked: RankedCandidate[] = [
      ...local.map((candidate) => ({ candidate, score: localScore, pressure: localPressure, tierRank: LOCAL_TIER_RANK })),
      ...this.peerCandidates(model, peers, weight),
    ];
    // Stable sort: candidates that tie on every key keep insertion order — local backends in
    // INFERENCE_BACKEND_TYPES order, then peers in the order the repository returned them.
    //
    // `weight ? … : 0` rather than always comparing: at weight 0 the middle key must not exist, or a
    // measured node would start winning ties that a static hardware tier decides today.
    const ordered = ranked
      .sort((a, b) => a.score - b.score || (weight ? a.pressure - b.pressure : 0) || a.tierRank - b.tierRank)
      .map((entry) => entry.candidate);
    const ceiling = measurePromptBytes
      ? this.applyPromptCeilings(model, ordered, peers, measurePromptBytes)
      : { preferred: ordered, overCeiling: [], decision: null };
    // Read from the same in-memory settings object every other pool knob comes from, so a pin takes
    // effect on the next request and costs no query on the inference hot path.
    const pin = resolvePinFor(this.configuration.getHubPoolPreferences().poolPins, model);
    // With no over-ceiling tail this is `applyPin(ordered, pin)` exactly, which is what keeps a fleet
    // without ceilings, and a request under every ceiling, on the order it had before ceilings existed.
    return {
      candidates: [...applyPin(ceiling.preferred, pin), ...applyPin(ceiling.overCeiling, pin)],
      pin,
      promptCeiling: ceiling.decision,
    };
  }

  /**
   * Each candidate's ceiling — this node's own (env override applied) for a local candidate, the
   * figure a peer advertised for a peer — then {@link applyPromptCeiling}.
   *
   * Local and peer ceilings come from the same places everything else in ranking does: the in-memory
   * settings object and the capability snapshots `usablePeers` already loaded, so this adds no query.
   * One debug line for each request the ceiling actually changed and nothing for the rest, never at
   * info: the routing log is where an operator reads decisions, and an agent sending long turns all
   * day would otherwise fill the process log with the same sentence.
   */
  private applyPromptCeilings(
    model: string,
    ordered: PoolCandidate[],
    peers: HubPoolPeer[],
    measurePromptBytes: () => number,
  ): ReturnType<typeof applyPromptCeiling> {
    const localCeiling = resolvePoolMaxPromptTokens(this.configuration.getHubPoolPreferences().poolMaxPromptTokens).maxPromptTokens;
    const peerCeilings = new Map<string, number | null>(
      peers.map((peer) => [peer.id, clampPromptCeiling((peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.maxPromptTokens)]),
    );
    const ceilingOf = (candidate: PoolCandidate) => (candidate.peerId === null ? localCeiling : (peerCeilings.get(candidate.peerId) ?? null));
    if (!ordered.some((candidate) => ceilingOf(candidate) !== null)) {
      return { preferred: ordered, overCeiling: [], decision: null };
    }
    const result = applyPromptCeiling(ordered, ceilingOf, estimatePromptTokens(measurePromptBytes()));
    const decision = result.decision;
    if (decision && decision.excluded.length > 0) {
      const nodes = decision.excluded.map((entry) => `${entry.node} (ceiling ${entry.maxPromptTokens})`).join(', ');
      this.logger.debug(
        decision.overridden
          ? `[PoolProxy] ~${decision.estimatedTokens}-token prompt for "${model}" is over every candidate's ceiling — ${nodes} — so placing it anyway`
          : `[PoolProxy] ~${decision.estimatedTokens}-token prompt for "${model}" put ${nodes} behind every candidate under its ceiling`,
      );
    }
    return result;
  }

  async proxyRequest(params: { path: string; method: string; body: unknown; model: string; res: Response }): Promise<void> {
    const { path, method, res } = params;
    const startedAt = Date.now();
    const clientClosed = abortWhenClientCloses(res);
    const model = await this.resolveModelAlias(params.model);
    if (!model) {
      this.routingLog.record({
        at: new Date().toISOString(),
        direction: 'outbound',
        path,
        model: params.model,
        node: null,
        peerId: null,
        backend: null,
        candidates: 0,
        attempt: 0,
        failedOverFrom: [],
        pin: null,
        promptCeiling: null,
        outcome: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        usage: null,
      });
      res.status(502).json({ error: describeUnresolvableAuto() });
      return;
    }
    // The engine gets the resolved id, never the alias: it is the pool that knows what `auto` means
    // here, and a peer's engine would refuse the literal word.
    const aliasedBody = model === params.model || !isRecord(params.body) ? params.body : { ...params.body, model };
    // Streamed OpenAI-compatible dialects only report token usage when the request opts in — the
    // app that originated this call has no reason to know that, so the proxy adds it here rather
    // than never seeing a usage frame at all. See `response-usage-tap.ts`.
    const body = injectUsageOptIn(aliasedBody);
    const { candidates, pin, promptCeiling } = await this.rankCandidates(
      model,
      PROMPT_CEILING_PATHS.has(path) ? () => forwardedPayload(method, body)?.length ?? 0 : undefined,
    );
    // Nodes a candidate rejected before one answered. Non-empty in the finished record is exactly
    // what makes it a failover, so the whole chain is one entry rather than one per attempt.
    const failedOverFrom: string[] = [];

    if (candidates.length === 0) {
      this.routingLog.record({
        at: new Date().toISOString(),
        direction: 'outbound',
        path,
        model,
        node: null,
        peerId: null,
        backend: null,
        candidates: 0,
        attempt: 0,
        failedOverFrom,
        pin: describePinForLog(pin),
        promptCeiling,
        outcome: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        usage: null,
      });
      res.status(502).json({ error: describeNoCandidates(model, pin) });
      return;
    }

    // Opened at placement, not at first byte. On a self-hosted engine an agent turn waits minutes
    // for its headers (a 160 KB prompt into a cold 27B: 131.8 s measured, 245 s under load), and
    // until this row existed the operator's activity panel showed nothing for the whole wait
    // while its own caption promised a record "when a request is placed". The row names the
    // candidate currently being tried and is updated in place through each failover.
    // Non-empty: the `candidates.length === 0` branch above has already returned.
    const first = candidates[0] as PoolCandidate;
    const row = this.routingLog.open({
      at: new Date().toISOString(),
      direction: 'outbound',
      path,
      model,
      node: first.nodeFqdn ?? LOCAL_CANDIDATE_KEY,
      peerId: first.peerId,
      backend: first.backend,
      candidates: candidates.length,
      attempt: 1,
      failedOverFrom,
      pin: describePinForLog(pin),
      promptCeiling,
    });

    let lastError: unknown;
    let committed = false;
    for (const [index, candidate] of candidates.entries()) {
      const key = candidate.peerId ?? LOCAL_CANDIDATE_KEY;
      const nodeLabel = candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY;
      if (index > 0) {
        Object.assign(row, { node: nodeLabel, peerId: candidate.peerId, backend: candidate.backend, attempt: index + 1 });
      }
      // Reaching an over-ceiling node means every node under a ceiling already failed. Recorded as an
      // override, so the log reads "placed over its ceiling" instead of claiming the node was skipped.
      if (row.promptCeiling && !row.promptCeiling.overridden && row.promptCeiling.excluded.some((entry) => entry.node === nodeLabel)) {
        row.promptCeiling.overridden = true;
        this.logger.debug(
          `[PoolProxy] every candidate under its prompt ceiling failed for "${model}"; trying ${nodeLabel}, which is over its ceiling`,
        );
      }
      this.loadService.acquire(key);
      try {
        const upstream = await this.forward(candidate, path, method, body, model, clientClosed);
        // Before the failover branch, so both outcomes teach the local engine the same thing: a
        // live request is the only place the pool ever learns whether a model actually serves.
        this.noteLocalServing(candidate, model, upstream.status);
        if (this.shouldFailover(candidate, upstream.status)) {
          lastError = new Error(`${candidate.nodeFqdn ?? 'local'} returned ${upstream.status}`);
          failedOverFrom.push(nodeLabel);
          await this.noteRejectedCandidate(candidate, upstream.status);
          continue;
        }
        // Settled here rather than after the stream: headers are the routing decision, and the
        // generation that follows can run for minutes (or never end, if the client hung up).
        this.routingLog.settle(row, {
          node: nodeLabel,
          peerId: candidate.peerId,
          backend: candidate.backend,
          attempt: index + 1,
          outcome: 'served',
          status: upstream.status,
          durationMs: Date.now() - startedAt,
        });
        // Attribution rides on the commit, so it is on the wire before the first body byte on the
        // streamed path too — the headers are the point of no return, the body follows.
        this.commitResponse(upstream, res, servedByHeaders(candidate, model));
        committed = true;
        await this.streamResponse(upstream, res, (usage) => this.routingLog.attachUsage(row, usage));
        return;
      } catch (error) {
        if (clientClosed.aborted) {
          // Not a candidate failure, and never a reason to try the next one: nobody is left to read
          // the answer, and placing the turn again would cost a second engine the same prefill.
          this.noteClientClosed(row, committed, index, startedAt, nodeLabel);
          return;
        }
        lastError = error;
        failedOverFrom.push(nodeLabel);
        this.logger.warn(
          `[PoolProxy] candidate ${candidate.nodeFqdn ?? 'local'} (${candidate.backend}) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (committed) {
          // Status and headers (and likely some generated tokens) are already on the wire. Another
          // candidate would restart the answer into a response the client is mid-way through
          // reading, so let the stream die instead and leave the client to retry.
          this.logger.warn('[PoolProxy] response already committed to the client; not failing over');
          res.destroy();
          return;
        }
      } finally {
        this.loadService.release(key);
      }
    }

    this.routingLog.settle(row, {
      node: null,
      peerId: null,
      backend: null,
      attempt: candidates.length,
      outcome: 'failed',
      status: null,
      durationMs: Date.now() - startedAt,
    });
    this.logger.error(
      `[PoolProxy] all ${candidates.length} candidate(s) for model "${model}" failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    this.respondUncommitted(res, 502, { error: describeAllCandidatesFailed(model, candidates.length, lastError) });
  }

  /**
   * Close out a routed request whose client left. Before headers the row is still pending and is
   * settled as failed with no status — nothing was served — and it is logged, because a client giving
   * up on a turn that had not started answering is the one symptom of a queue too slow for its callers.
   * After headers the row already says served, which it was, and a stopped generation is routine.
   */
  private noteClientClosed(
    row: ReturnType<HubPoolRoutingLogService['open']>,
    committed: boolean,
    index: number,
    startedAt: number,
    nodeLabel: string,
  ): void {
    if (committed) {
      this.logger.debug(`[PoolProxy] client closed a streaming response from ${nodeLabel}; upstream request aborted`);
      return;
    }
    const waitedMs = Date.now() - startedAt;
    this.routingLog.settle(row, {
      node: null,
      peerId: null,
      backend: null,
      attempt: index + 1,
      outcome: 'failed',
      status: null,
      durationMs: waitedMs,
    });
    this.logger.log(`[PoolProxy] client closed the request after ${waitedMs}ms while ${nodeLabel} had not answered; upstream request aborted`);
  }

  /**
   * Whether a candidate's response status should send us to the next candidate. Depends on the
   * candidate *kind*: a peer answers 401/403/404 about the pairing itself (its PoolPeerGuard, its
   * `forwardLocal` connected-check), which says nothing about the application's request — whereas
   * the same status from the local engine is the engine's verdict on the request and is passed
   * through untouched.
   */
  private shouldFailover(candidate: PoolCandidate, status: number): boolean {
    if (status >= 500) {
      return true;
    }
    return candidate.peerId === null ? TRANSPORT_4XX.has(status) : PEER_TRANSPORT_4XX.has(status);
  }

  /**
   * Feed a local engine's own answer back into its serving-capability signal, so the next
   * `localCandidates` knows something this request found out and no health poll could.
   *
   * Only 5xx counts as a failure. 408 and 429 fail over too, but they are the engine saying "not
   * now" about its queue, not "not ever" about the model — withholding a model because the node
   * was briefly busy would turn load shedding into an outage. Peers are skipped entirely: a peer's
   * capabilities are its own to correct (see {@link noteRejectedCandidate}), and a 500 relayed
   * through it says nothing about which of ITS backends failed.
   */
  private noteLocalServing(candidate: PoolCandidate, model: string, status: number): void {
    if (candidate.peerId !== null) {
      return;
    }
    this.noteLocalServingOutcome(candidate.backend, model, status);
  }

  /**
   * The rule itself, shared by the outbound path ({@link noteLocalServing}) and the peer-facing
   * inbound forward, so a model's serving record does not depend on which door the request came in.
   */
  private noteLocalServingOutcome(backendType: InferenceBackendType, model: string | undefined, status: number): void {
    if (!model) {
      return;
    }
    const backend = this.backends.tryGet(backendType);
    if (status >= 500) {
      backend?.noteServingFailure?.(model, `HTTP ${status}`);
      return;
    }
    if (status < 400) {
      // A 4xx is the engine's verdict on the *request*, not proof the model can run, so only a
      // clean response clears the record.
      backend?.noteServingSuccess?.(model);
    }
  }

  /** A peer that 401/403s no longer treats us as paired, so its cached model list is stale — stop offering it until the next successful health probe. */
  private async noteRejectedCandidate(candidate: PoolCandidate, status: number): Promise<void> {
    if (candidate.peerId === null || (status !== 401 && status !== 403)) {
      return;
    }
    this.logger.warn(`[PoolProxy] peer ${candidate.nodeFqdn} rejected our forward with ${status}; dropping its cached capabilities`);
    try {
      await this.peerService.clearCachedCapabilities(candidate.peerId);
    } catch (error) {
      this.logger.debug(
        `[PoolProxy] could not clear capabilities for ${candidate.nodeFqdn}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Terminal error write that never touches an already-committed response. */
  private respondUncommitted(res: Response, status: number, body: Record<string, unknown>): void {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    res.status(status).json(body);
  }

  /**
   * Forward straight to this node's own local backend and pipe the response —
   * used by the peer-facing `/inference/pool/local/*` routes, which must never
   * re-enter candidate selection (that's what stops a request being relayed
   * through a third node).
   */
  async forwardToLocalBackendAndRespond(
    backend: InferenceBackendType,
    path: string,
    method: string,
    body: unknown,
    res: Response,
    /** FQDN of the peer that sent us this work, for the routing log. Optional so the log is never what breaks a forward. */
    fromPeerFqdn?: string,
    /** Model the peer asked for, from `X-Hub-Pool-Model`. Optional: an older peer won't send it, and a missing model only costs us the strike, never the forward. */
    model?: string,
  ): Promise<void> {
    // Counted like a locally-routed request: a peer's forwarded work occupies this node's engine
    // exactly as its own apps' does, and a node busy serving the pool must not report itself idle
    // to the very peers deciding whether to send it more.
    const startedAt = Date.now();
    // The sending node aborting its own fetch closes this response, and this is the node whose engine
    // is doing the prefill — so the close has to be carried one hop further, to the engine.
    const senderClosed = abortWhenClientCloses(res);
    this.loadService.acquire(LOCAL_CANDIDATE_KEY);
    // Recorded once per forward, whichever way it ends: a stream that dies after the backend
    // answered is the same routing decision, not a second one.
    let recorded = false;
    try {
      const upstream = await this.callBackend(backend, path, method, body, senderClosed);
      // Logged from the receiving side too, so an operator can answer "which of my peers is
      // spending my GPU time" — the sender's own log only covers what it sent.
      this.recordInbound(backend, path, fromPeerFqdn, upstream.status, startedAt);
      recorded = true;
      // A peer's forward is the only evidence an inbound-only node ever gets that one of its own
      // models cannot run: nothing here goes through `proxyRequest`, so without this the node
      // earns no strikes, withholds nothing, and keeps advertising the dead model to its peers.
      this.noteLocalServingOutcome(backend, MODEL_METADATA_PATHS.has(path) ? undefined : model, upstream.status);
      await this.pipeResponse(upstream, res);
    } catch (error) {
      if (!recorded) {
        this.recordInbound(backend, path, fromPeerFqdn, null, startedAt);
      }
      if (senderClosed.aborted) {
        // Nobody to answer: rethrowing would only have Nest log a routine hang-up as a server error
        // and try to write a 500 to a closed socket.
        this.logger.debug(`[PoolProxy] ${fromPeerFqdn ?? 'a peer'} closed its forward of ${path}; local engine request aborted`);
        return;
      }
      throw error;
    } finally {
      this.loadService.release(LOCAL_CANDIDATE_KEY);
    }
  }

  /**
   * Record a peer forward this node refused before any backend saw it — an unconnected peer (403),
   * inbound pooling switched off, or that peer disabled here (503).
   *
   * Without this the refusal is invisible on the serving side: `recordInbound` is only reachable
   * once a backend has been called, so "why is my peer getting nothing from this node" had no
   * answer anywhere an operator can read. The sending node's own log shows the failover; this is
   * the other half of that story.
   */
  recordRefusedInboundForward(params: {
    backend: InferenceBackendType | null;
    path: string;
    fromPeerFqdn: string | undefined;
    status: number;
  }): void {
    // 'failed' explicitly: nothing was served, and the status is a 4xx that the served-path rule
    // below would otherwise read as success.
    this.recordInbound(params.backend, params.path, params.fromPeerFqdn, params.status, Date.now(), 'failed');
  }

  private recordInbound(
    backend: InferenceBackendType | null,
    path: string,
    fromPeerFqdn: string | undefined,
    status: number | null,
    startedAt: number,
    outcome?: PoolRoutingOutcome,
  ): void {
    this.routingLog.record({
      at: new Date().toISOString(),
      direction: 'inbound',
      path,
      // A peer forward carries the model in a body we deliberately never parse — it is passed
      // through untouched, and reading it here would mean holding the payload we promise not to log.
      model: null,
      node: fromPeerFqdn ?? null,
      peerId: null,
      backend,
      candidates: 1,
      attempt: 1,
      failedOverFrom: [],
      // Always null: a pin is THIS Hub's policy for work it originates. Work a peer forwards us is
      // never re-routed (see `forwardToLocalBackendAndRespond`), so no pin can have shaped it.
      pin: null,
      // Null for the same reason as the pin: the ceiling is applied by the node choosing where work goes.
      promptCeiling: null,
      outcome: outcome ?? (status !== null && status < 500 ? 'served' : 'failed'),
      status,
      durationMs: Date.now() - startedAt,
      // Inbound (peer-forwarded) usage capture is out of scope for now — see the PR description.
      // `forwardToLocalBackendAndRespond` calls the shared `pipeResponse`/`callBackend` path, not
      // `proxyRequest`, so wiring this in later means threading the same tap through there too.
      usage: null,
    });
  }

  /**
   * Best-effort passthrough for the endpoints that carry no `model` field and so can't be routed
   * across the pool — `GET /v1/models`, `GET /api/tags`, `GET /api/ps`, `GET /api/version`,
   * `POST /api/show`. Tries this node's own backends in order and serves the first that answers.
   * Cross-node merging of the listing endpoints is a known gap; see docs/hub-pool.md.
   */
  async proxyLocalOnlyRequest(path: string, method: string, body: unknown, res: Response): Promise<void> {
    const clientClosed = abortWhenClientCloses(res);
    // Ollama's `/api/show` names the model in `name` (older clients) or `model`, and an app whose
    // chat model is the `auto` alias asks about `auto` here before its first chat — OpenClaw's
    // provider does exactly that, and read the engine's 404 as "model not found" without ever
    // sending the chat. It resolves here exactly as the chat will, so the model described is the
    // model that runs; when that model lives only on a peer, the peer describes it (below).
    const resolvedBody = await this.resolveLocalOnlyAlias(body);
    if (resolvedBody === null) {
      this.respondUncommitted(res, 502, { error: describeUnresolvableAuto() });
      return;
    }
    let committed = false;
    for (const type of INFERENCE_BACKEND_TYPES) {
      try {
        const upstream = await this.callBackend(type, path, method, resolvedBody, clientClosed);
        if (!upstream.ok) {
          this.logger.debug(`[PoolProxy] ${path} via local ${type} answered ${upstream.status}; trying the next backend`);
          continue;
        }
        this.commitResponse(upstream, res);
        committed = true;
        await this.streamResponse(upstream, res);
        return;
      } catch (error) {
        this.logger.debug(`[PoolProxy] ${path} via local ${type} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (committed || clientClosed.aborted) {
          res.destroy();
          return;
        }
      }
    }
    if (MODEL_METADATA_PATHS.has(path) && (await this.describeFromPeer(path, resolvedBody, res, clientClosed))) {
      return;
    }
    // `/api/version` and `/api/tags` are how an Ollama-native caller (e.g. ci-hermes with
    // CI_HERMES_OLLAMA_NATIVE=1) decides whether this proxy speaks Ollama's native protocol at
    // all. A 502 here is read by that caller as "not Ollama" and silently downgrades it to the
    // OpenAI-compatible `/v1` surface — which drops `num_ctx` — with nothing logged on ITS side
    // for a plain 404/502 (see CI-Hermes `ollama_native_adapter.py::_probe_is_ollama`, which only
    // warns on an indeterminate 401/403). This is the one place on the Hub's side that can still
    // say so, at `warn` rather than the `debug` every other local-only path failure gets.
    if (NATIVE_CAPABILITY_PROBE_PATHS.has(path)) {
      this.logger.warn(
        `[PoolProxy] no local backend could serve ${path}; a caller probing this route to decide native-vs-OpenAI-compatible ` +
          'routing (e.g. ci-hermes) will silently fall back to /v1 and lose per-request context-length control.',
      );
    }
    this.respondUncommitted(res, 502, { error: `No local backend able to serve ${path}` });
  }

  /**
   * Answer a model-metadata request (`/api/show`) from a peer that holds the model, once no local
   * backend could. `true` when a response was committed.
   *
   * Needed because `auto` now resolves pool-wide: on a node with no local copy of the chosen model
   * the local engines can only 404, and OpenClaw reads that 404 as "model not found" and never sends
   * the chat that would have been served. Not routed through {@link proxyRequest}, deliberately —
   * a metadata lookup is not a turn, and it must not open a routing-log row, count as queue depth,
   * or feed the model's serving record. A peer on a build without `local/api/show` answers 404,
   * which moves on to the next peer and, with none left, to the same 502 as before.
   */
  private async describeFromPeer(path: string, body: unknown, res: Response, clientClosed: AbortSignal): Promise<boolean> {
    const model = isRecord(body)
      ? [body.model, body.name].find((value): value is string => typeof value === 'string' && value.length > 0)
      : undefined;
    if (!model) {
      return false;
    }
    // No `measurePromptBytes`, and that omission is the point rather than an oversight: a prompt
    // ceiling is a statement about how long a TURN this node is willing to prefill, and a metadata
    // lookup is not a turn. Its body is the model name — tens of bytes — so measuring it would
    // compare a node's turn ceiling against a number that has nothing to do with one, and a node
    // that advertised a small ceiling would be demoted out of first place for a request it can
    // answer in a millisecond. The exemption is belt-and-braces with `PROMPT_CEILING_PATHS`, which
    // lists only the four generation paths and so already excludes every {@link MODEL_METADATA_PATHS}
    // entry on the `proxyRequest` side; keep both, because they guard different callers.
    const { candidates } = await this.rankCandidates(model);
    for (const candidate of candidates) {
      if (clientClosed.aborted) {
        break;
      }
      if (candidate.peerId === null) {
        continue;
      }
      let committed = false;
      try {
        const upstream = await this.forwardWithHeadersDeadline(candidate, path, body, model, clientClosed);
        if (!upstream.ok) {
          this.logger.debug(`[PoolProxy] ${path} for "${model}" via ${candidate.nodeFqdn} answered ${upstream.status}; trying the next peer`);
          continue;
        }
        this.commitResponse(upstream, res, servedByHeaders(candidate, model));
        committed = true;
        await this.streamResponse(upstream, res);
        return true;
      } catch (error) {
        this.logger.debug(
          `[PoolProxy] ${path} for "${model}" via ${candidate.nodeFqdn} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (committed) {
          res.destroy();
          return true;
        }
      }
    }
    return false;
  }

  /** {@link forward} for a metadata lookup: aborted if the peer has not sent headers within {@link PEER_MODEL_METADATA_HEADERS_TIMEOUT_MS}. */
  private async forwardWithHeadersDeadline(
    candidate: PoolCandidate,
    path: string,
    body: unknown,
    model: string,
    clientClosed: AbortSignal,
  ): Promise<globalThis.Response> {
    const headersDeadline = new AbortController();
    const timer = setTimeout(
      () => headersDeadline.abort(new Error(`No response headers within ${PEER_MODEL_METADATA_HEADERS_TIMEOUT_MS}ms`)),
      PEER_MODEL_METADATA_HEADERS_TIMEOUT_MS,
    );
    try {
      return await this.forward(candidate, path, 'POST', body, model, AbortSignal.any([clientClosed, headersDeadline.signal]));
    } finally {
      clearTimeout(timer);
    }
  }

  /** `null` when the body asks for `auto` and nothing can stand in for it; otherwise the body to forward. */
  private async resolveLocalOnlyAlias(body: unknown): Promise<unknown | null> {
    if (!isRecord(body)) return body;
    const fields = ['name', 'model'].filter((field) => body[field] === AUTO_MODEL);
    if (fields.length === 0) return body;
    const resolved = await this.resolveModelAlias(AUTO_MODEL);
    if (!resolved) return null;
    return { ...body, ...Object.fromEntries(fields.map((field) => [field, resolved])) };
  }

  /**
   * This node's own backends that can serve `model`.
   *
   * "Has it" and "can serve it" are separate questions, and the inventory only answers the first:
   * `health.modelsLoaded` is what the engine has on **disk**. A fleet node was found answering
   * `/api/tags` 200 with `gemma3:1b` while every `/api/generate` for it returned HTTP 500 `model
   * failed to load` — on the inventory alone that node was a first-choice candidate for a model it
   * could not serve once, and it advertised the same claim to every peer. So a model the backend
   * has withheld (see `BackendHealthStatus.unservableModels`) is dropped here even though it is
   * sitting right there in the inventory.
   */
  private async localCandidates(model: string): Promise<PoolCandidate[]> {
    const results = await Promise.all(
      this.backends.entries().map(async ([type, backend]): Promise<PoolCandidate | null> => {
        try {
          const health = await backend.healthCheck();
          if (!health.running || !health.healthy || !inventoryListsModel(health.modelsLoaded, model)) {
            return null;
          }
          if (inventoryListsModel(health.unservableModels, model)) {
            this.logger.debug(`[PoolProxy] local ${type} lists "${model}" but has been unable to serve it; not offering it as a candidate`);
            return null;
          }
          return { peerId: null, nodeFqdn: null, backend: type };
        } catch (error) {
          this.logger.debug(`[PoolProxy] local ${type} health check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      }),
    );
    return results.filter((c): c is PoolCandidate => c !== null);
  }

  /**
   * The connected peers this node may send work to right now: the outbound kill switch, then each
   * peer's own switch.
   *
   * This filter lives here, on the request path, and NOT in `HubPoolPeerService.listConnectedPeers`
   * — which is the obvious place and is the wrong one. That method also answers
   * `hasConnectedPeers()`, which `inference-env-resolver.ts` consults once, at app INSTALL time, to
   * decide whether an app's `CI_LLM_BASE_URL` points at this proxy or straight at a backend. Gating
   * it there would mean every app created while outbound was off is permanently pointed away from
   * the pool, and turning the switch back on would not bring it back — a routing preference would
   * have silently become an app's baked-in configuration.
   *
   * Consequences here are all intended and all reversible: candidate selection produces local
   * candidates only, and if this node cannot serve the model the caller gets the existing
   * actionable 502 rather than the request being shipped out.
   */
  private async usablePeers(): Promise<HubPoolPeer[]> {
    if (!this.directions().outbound.enabled) {
      return [];
    }
    // `!== false`, not truthiness: the column is NOT NULL DEFAULT true, so only an explicit
    // operator decision may remove a peer from routing — never a row that somehow lacks the field.
    return (await this.peerService.listConnectedPeers()).filter((peer) => peer.enabled !== false);
  }

  private peerCandidates(model: string, peers: HubPoolPeer[], weight: number): RankedCandidate[] {
    const candidates: RankedCandidate[] = [];
    for (const peer of peers) {
      const capabilities = peer.lastCapabilities as unknown as PoolPeerCapabilities | null;
      if (!capabilities) continue;
      // Skipped on the flag itself, not on an empty inventory: a peer that has switched inbound off
      // (or disabled us) is a healthy machine we keep polling successfully, and an empty `backends`
      // is pixel-identical to one whose engines are simply down. `undefined` means a peer on an
      // older build, which never refuses, so absence must read as "yes".
      if (capabilities.acceptingWork === false) continue;
      const match = capabilities.backends.find((b) => b.healthy && inventoryListsModel(b.modelsLoaded, model));
      if (match) {
        const pressure = this.peerPressure(peer, capabilities) ?? UNKNOWN_PRESSURE;
        candidates.push({
          candidate: { peerId: peer.id, nodeFqdn: peer.nodeFqdn, backend: match.type },
          score: this.peerLoad(peer, capabilities) + weight * pressure + this.localAffinity(),
          pressure,
          tierRank: this.tierRank(capabilities.hardwareTier),
        });
      }
    }
    return candidates;
  }

  /** `hardwareTier` arrives as free-form JSON from the peer, so an unrecognised value must land somewhere sane rather than at the top. */
  private tierRank(hardwareTier: string): number {
    return TIER_RANK[hardwareTier as keyof typeof TIER_RANK] ?? UNKNOWN_TIER_RANK;
  }

  /**
   * A peer's queue depth, from the two vantage points we have on it: what it reported at its last
   * health poll, and what we have forwarded it since. Both count the same requests, so the larger
   * wins rather than the sum — the snapshot sees work from apps and nodes we cannot observe, our own
   * counter sees the up-to-30s the snapshot missed.
   */
  private peerLoad(peer: HubPoolPeer, capabilities: PoolPeerCapabilities): number {
    return Math.max(this.loadService.get(peer.id), this.reportedPeerLoad(peer, capabilities));
  }

  /** Self-reported queue depth, or {@link UNKNOWN_PEER_LOAD} when the snapshot is stale or carries no figure. */
  private reportedPeerLoad(peer: HubPoolPeer, capabilities: PoolPeerCapabilities): number {
    // Freshness comes from the shared helper so that load and pressure — two fields of one snapshot
    // — can never drift apart on what "stale" means. It is judged on lastSeenAt, stamped by OUR
    // clock when the probe succeeded, not on capabilities.updatedAt, which is the peer's.
    if (!this.isSnapshotFresh(peer)) {
      return UNKNOWN_PEER_LOAD;
    }
    return capabilities.inFlightRequests ?? UNKNOWN_PEER_LOAD;
  }

  private isSnapshotFresh(peer: HubPoolPeer): boolean {
    return isCapabilitiesSnapshotFresh(peer.lastSeenAt, this.capabilitiesFreshnessMs());
  }

  /**
   * A peer's effective pressure band, or `null` when nothing about its GPU is known.
   *
   * Every decision here lives in `effectivePeerPressureBand`, deliberately: `lastCapabilities` is
   * jsonb a paired peer fully controls, so the hostile-value clamp and the "what we have forwarded
   * is a floor" anti-gaming rule have to be the same code `/pool/status` shows the operator.
   * Otherwise the status card would print a number routing does not believe.
   */
  private peerPressure(peer: HubPoolPeer, capabilities: PoolPeerCapabilities): number | null {
    return effectivePeerPressureBand({
      reported: capabilities.gpuPressure,
      snapshotFresh: this.isSnapshotFresh(peer),
      forwardedInFlight: this.loadService.get(peer.id),
    });
  }

  private async callBackend(
    backend: InferenceBackendType,
    path: string,
    method: string,
    body: unknown,
    clientClosed?: AbortSignal,
  ): Promise<globalThis.Response> {
    const backendImpl = this.backends.get(backend);
    const url = `${backendImpl.getBaseUrl()}${path}`;
    const apiKey = backendImpl.getApiKey?.();
    const payload = forwardedPayload(method, body);
    return this.fetchWithConnectTimeout(
      url,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: payload,
      },
      isStreamingRequest(body),
      payload?.length ?? 0,
      clientClosed,
    );
  }

  private async forward(
    candidate: PoolCandidate,
    path: string,
    method: string,
    body: unknown,
    model: string,
    clientClosed?: AbortSignal,
  ): Promise<globalThis.Response> {
    if (candidate.peerId === null) {
      return this.callBackend(candidate.backend, path, method, body, clientClosed);
    }

    const peer = await this.peerService.getPeerById(candidate.peerId);
    if (!peer) {
      throw new Error(`Peer ${candidate.peerId} is no longer paired`);
    }
    const requestPath = `/api/inference/pool/local${path}`;
    const url = `https://${peer.nodeFqdn}${requestPath}`;
    // One helper for the credential, whichever kind it is — see `HubPoolPeerService.peerAuthHeaders`.
    // The body is passed but deliberately not hashed on this path: `poolRequestSignsBody` excludes
    // `/local/*`, because the recipient UUID, nonce and timestamp already make a captured request
    // unreplayable, and canonicalizing a megabyte embeddings batch per hop is not affordable here.
    const authHeaders = await this.peerService.peerAuthHeaders(peer, method, requestPath, body);
    const peerPayload = forwardedPayload(method, body);
    return this.fetchWithConnectTimeout(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          // Tells the peer's `/inference/pool/local/*` handler which of ITS OWN backends to hit —
          // it can't infer this from the path alone, and must not re-run candidate selection itself.
          [POOL_BACKEND_HEADER]: candidate.backend,
          // Lets the receiver credit the outcome to the right model without parsing the body it
          // promises not to read. Same reason as the header above: the path alone doesn't carry it.
          [POOL_MODEL_HEADER]: model,
          ...authHeaders,
        },
        body: peerPayload,
      },
      isStreamingRequest(body),
      peerPayload?.length ?? 0,
      clientClosed,
    );
  }

  /**
   * `fetch` with a deadline sized to what we are actually waiting for.
   *
   * Streamed: headers arrive almost immediately, so the short connect budget is the right guard and
   * the timer is cleared before the body flows — a long generation is never cut off mid-stream.
   * Non-streamed: headers arrive only when the completion is finished, so the wait we are timing IS
   * the generation, and the budget has to be sized for one. See COMPLETION_TIMEOUT_MS.
   *
   * `clientClosed` is combined with the deadline rather than checked around it, because the signal
   * given to `fetch` also governs the response body: after headers the deadline timer is cleared, but
   * a client that leaves mid-stream still aborts the upstream connection. See CLIENT_CLOSED_MESSAGE.
   */
  private async fetchWithConnectTimeout(
    url: string,
    init: RequestInit,
    streaming = false,
    bodyBytes = 0,
    clientClosed?: AbortSignal,
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    // A streamed request's first byte waits on the prompt being read, so its budget grows with the
    // prompt (see MIN_PREFILL_TOKENS_PER_SEC); a non-streamed one waits on the whole completion.
    const budget = streaming ? firstByteBudgetMs(bodyBytes) : Math.max(COMPLETION_TIMEOUT_MS, firstByteBudgetMs(bodyBytes));
    const timer = setTimeout(
      () => controller.abort(new Error(streaming ? `No response headers within ${budget}ms` : `No completion within ${budget}ms`)),
      budget,
    );
    try {
      const dispatcher = poolFetchDispatcher();
      // `dispatcher` is a Node fetch extension, not part of the DOM RequestInit type.
      const signal = clientClosed ? AbortSignal.any([controller.signal, clientClosed]) : controller.signal;
      const response = await fetch(url, { ...init, signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Status line + headers only. Deliberately separate from {@link streamResponse}: it is the point
   * of no return for failover, and callers need to know which side of it a failure landed on.
   *
   * `attribution` is the routed path's serving-node statement (see {@link servedByHeaders}). It is
   * set here, and nowhere later, because Node flushes headers on the first body write: anything
   * set after `streamResponse` starts would be ERR_HTTP_HEADERS_SENT on a streamed completion.
   * Upstream `x-hub-pool-*` headers are dropped whether or not there is an attribution to replace
   * them — see {@link POOL_HEADER_PREFIX}.
   */
  private commitResponse(upstream: globalThis.Response, res: Response, attribution?: Record<string, string>): void {
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const name = key.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(name) && !name.startsWith(POOL_HEADER_PREFIX)) {
        res.setHeader(key, value);
      }
    });
    for (const [name, value] of Object.entries(attribution ?? {})) {
      res.setHeader(name, value);
    }
  }

  /**
   * `onUsage`, when given, taps the body for a token-usage frame while it streams through — see
   * `response-usage-tap.ts`. Optional because not every caller has a routing-log row to attach it
   * to (`pipeResponse`, the inbound/listing paths below, records usage nowhere today).
   */
  private async streamResponse(upstream: globalThis.Response, res: Response, onUsage?: (usage: PoolRoutingUsage) => void): Promise<void> {
    if (!upstream.body) {
      res.end();
      return;
    }
    const webBody = upstream.body as WebReadableStream<Uint8Array>;
    const body = onUsage ? tapResponseUsageWhileStreaming(webBody, onUsage) : webBody;
    await pipeline(Readable.fromWeb(body), res);
  }

  private async pipeResponse(upstream: globalThis.Response, res: Response): Promise<void> {
    this.commitResponse(upstream, res);
    await this.streamResponse(upstream, res);
  }
}
