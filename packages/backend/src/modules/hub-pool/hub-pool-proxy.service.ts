import { ReadableStream as WebReadableStream } from 'node:stream/web';
import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Response } from 'express';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import type { EngineCapabilities } from '@/modules/inference/backends/backend.interface';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { RelayError, relayToResponse, watchResponseClose, type ResponseCloseWatch } from '@/modules/inference/upstream-stream';
import { QUARANTINE_STRIKES, STRIKE_WINDOW_MS } from '@/modules/inference/backends/serving-quarantine';
import { ConfigurationService } from '@/core/config/configuration.service';
import { clampContextCap } from '@/common/helpers/inference-context-cap';
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
  sameModelId,
  type HubPoolDirectionalState,
  type HubPoolPin,
} from '@/common/helpers/hub-pool';
import { clampOllamaSlots } from '@/common/helpers/inference-ollama-slots';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY, type LocalGeneration, type LocalModelWork } from './hub-pool-load.service';
import {
  HubPoolRoutingLogService,
  type PoolRoutingAffinity,
  type PoolRoutingCeilingExclusion,
  type PoolRoutingContention,
  type PoolRoutingContentionDemotion,
  type PoolRoutingContextCap,
  type PoolRoutingContextCapExclusion,
  type PoolRoutingOutcome,
  type PoolRoutingPin,
  type PoolRoutingAttempt,
  type PoolRoutingPromptCeiling,
  type PoolRoutingRecord,
  type PoolRoutingRecordInput,
  type PoolRoutingRequestError,
  type PoolRoutingSlotDemotion,
  type PoolRoutingSlots,
  type PoolRoutingThroughput,
  type PoolRoutingThroughputEstimate,
  type PoolRoutingThroughputSlowerDemotion,
  type PoolRoutingThroughputUnmeasured,
  type PoolRoutingUsage,
} from './hub-pool-routing-log.service';
import { HubPoolPressureService } from './hub-pool-pressure.service';
import { HubPoolLocalHealthService, PLACEMENT_PROBE_BUDGET_MS, type LocalBackendHealth } from './hub-pool-local-health.service';
import {
  HubPoolThroughputService,
  missesBudget,
  predictPrefill,
  prefillPointsOf,
  readAdvertisedThroughput,
  SLOWER_PLACEMENT_FLOOR_MS,
  SLOWER_PLACEMENT_MAX_EXTRA_IN_FLIGHT,
  SLOWER_PLACEMENT_RATIO,
  UNMEASURED_DEFER_MIN_PROMPT_TOKENS,
  unmeasuredPriorOf,
  type PrefillPrediction,
  type SourcedPrefillPoint,
  type ThroughputTarget,
  type UnmeasuredPrior,
} from './hub-pool-throughput.service';
import {
  injectUsageOptIn,
  tapResponseUsageWhileStreaming,
  type EngineTimings,
  type PromptRead,
  type ResponseTapObserver,
} from './response-usage-tap';
import { POOL_AFFINITY_HEADER, PrefixAffinityStore, applyPrefixAffinity, derivePrefixKey, type PrefixKey } from './hub-pool-prefix-affinity';
import { chooseAutoModel, collectPoolModelOffers, type AutoModelPreference, type NodeModelInventory } from './pool-auto-model';
import {
  judgeRequestError,
  lastCandidateRequestError,
  passedThroughRequestError,
  readRequestErrorVerdict,
  type PoolRequestErrorVerdict,
  type UnconfirmedRequestError,
} from './hub-pool-request-error';
import { CONNECT_TIMEOUT_MS, MIN_PREFILL_TOKENS_PER_SEC, estimatePromptTokens, forwardBudgetMs } from './hub-pool-budget';
import {
  MAX_JUDGED_BODY_BYTES,
  OutputJudge,
  PoolOutputQuarantine,
  applyOutputQuarantine,
  describeOutputFault,
  isStreamedContentType,
  judgeWholeBody,
  outputDialectOf,
  type OutputTarget,
  type OutputVerdict,
  type PoolOutputFault,
} from './hub-pool-output-check';
import {
  LOCAL_LISTING_DEADLINE_MS,
  MERGED_LISTING_PATHS,
  gatherListings,
  listedModelIds,
  mergeLocalListings,
  mergeModelListing,
  peerOnlyModels,
} from './pool-model-listing';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { PoolCandidate, PoolPeerCapabilities } from './hub-pool.types';
import { parseDbTimestampMs } from '@/common/helpers/db-timestamp';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A forward that ran out of its budget, as the abort reason `fetch` rejects with. Typed so a missed
 * deadline can be recorded as throughput evidence without matching on a message the operator-facing
 * 502 text depends on.
 */
export class PoolForwardDeadlineError extends Error {
  constructor(
    message: string,
    readonly budgetMs: number,
  ) {
    super(message);
    this.name = 'PoolForwardDeadlineError';
  }
}

/** Our own budget running out, or undici's 300 s header timer when `poolFetchDispatcher` could not be installed. */
export function isForwardDeadline(error: unknown): boolean {
  if (error instanceof PoolForwardDeadlineError) {
    return true;
  }
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  return cause?.code === 'UND_ERR_HEADERS_TIMEOUT';
}

/**
 * `HUB_POOL_THROUGHPUT_PLACEMENT=off` (or `0`/`false`) stops measured rates from reordering candidates.
 * Measuring and advertising carry on, so turning it back on needs no warm-up. Read per request, like
 * every other pool override.
 */
export const HUB_POOL_THROUGHPUT_PLACEMENT_ENV_VAR = 'HUB_POOL_THROUGHPUT_PLACEMENT';
function throughputPlacementEnabled(): boolean {
  return placementSwitchOn(HUB_POOL_THROUGHPUT_PLACEMENT_ENV_VAR);
}

/**
 * `HUB_POOL_CONTENTION_PLACEMENT=off` (or `0`/`false`) stops a local engine that is busy with work a
 * request cannot join from giving way to peers — see {@link applyLocalContention}. Read per request,
 * like the throughput switch.
 */
export const HUB_POOL_CONTENTION_PLACEMENT_ENV_VAR = 'HUB_POOL_CONTENTION_PLACEMENT';

/** A placement step's env kill switch: on unless it says `off`, `0` or `false`. */
function placementSwitchOn(envVar: string): boolean {
  const raw = process.env[envVar]?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

/**
 * `HUB_POOL_SLOWER_PLACEMENT_RATIO` and `HUB_POOL_SLOWER_PLACEMENT_FLOOR_MS` retune how much slower
 * the candidate about to go first must be predicted to be before a faster one goes ahead of it — see
 * {@link applySlowerPlacement}. A ratio below 1, a negative floor, or anything that is not a finite
 * number reads as the default rather than a guess, and a very large ratio (1000) turns the rule off
 * on its own; `HUB_POOL_THROUGHPUT_PLACEMENT=off` turns it off with the rest of throughput placement.
 * Read per request, like the switches above.
 */
export const HUB_POOL_SLOWER_PLACEMENT_RATIO_ENV_VAR = 'HUB_POOL_SLOWER_PLACEMENT_RATIO';
export const HUB_POOL_SLOWER_PLACEMENT_FLOOR_MS_ENV_VAR = 'HUB_POOL_SLOWER_PLACEMENT_FLOOR_MS';
function slowerPlacementThresholds(): { ratio: number; floorMs: number } {
  const ratio = finiteEnvNumber(HUB_POOL_SLOWER_PLACEMENT_RATIO_ENV_VAR);
  const floorMs = finiteEnvNumber(HUB_POOL_SLOWER_PLACEMENT_FLOOR_MS_ENV_VAR);
  return {
    ratio: ratio !== null && ratio >= 1 ? ratio : SLOWER_PLACEMENT_RATIO,
    floorMs: floorMs !== null && floorMs >= 0 ? floorMs : SLOWER_PLACEMENT_FLOOR_MS,
  };
}

/** An env var as a finite number, `null` when unset or blank — `Number('')` is 0, which is a value, not an absence. */
function finiteEnvNumber(envVar: string): number | null {
  const raw = process.env[envVar]?.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function memoize<T>(compute: () => T): () => T {
  let computed = false;
  let value: T;
  return () => {
    if (!computed) {
      value = compute();
      computed = true;
    }
    return value;
  };
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
 * The embedding routes. A batch holds its model's runner for as long as it runs, exactly as a turn
 * does, so it is recorded as work on that model ({@link LocalModelWork}) for the Hub's eviction plan
 * to leave alone. It is not a generation: nothing in the contention or throughput judgements reads it.
 */
const EMBEDDING_PATHS: ReadonlySet<string> = new Set(['/v1/embeddings', '/api/embed', '/api/embeddings']);

/**
 * `stream`, `bodyBytes` and `budgetMs` for the routing log, from the body as it will be forwarded.
 *
 * This serialises the body once more than the forward itself does. Measured on a dev Mac: 0.9 ms for
 * a 184 KB agent turn and 3.5 ms for a 1 MB embeddings batch, against requests that take seconds to
 * minutes — cheaper than threading a pre-serialised payload through every forward signature. The
 * budget reads the string length, exactly as the forward's timer does; `bodyBytes` is the UTF-8 size
 * on the wire, and the two differ only for non-ASCII text.
 */
export function describeRequestShape(method: string, body: unknown, path?: string): { stream: boolean; bodyBytes: number; budgetMs: number } {
  const payload = method === 'GET' ? '' : (JSON.stringify(body) ?? '');
  const stream = isStreamingRequest(body, path);
  return { stream, bodyBytes: Buffer.byteLength(payload, 'utf8'), budgetMs: forwardBudgetMs(stream, payload.length) };
}

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

/**
 * Ollama's native generation routes, which stream unless the body says `stream: false`. Every other
 * pooled route — the OpenAI-compatible ones, and `/api/embed` — answers in one body unless asked to
 * stream.
 */
const STREAMS_BY_DEFAULT_PATHS: ReadonlySet<string> = new Set(['/api/chat', '/api/generate']);

/**
 * Does this request get a streamed response? Decides which of the two budgets applies, and whether
 * the pool can hold the answer to judge it before sending any of it.
 *
 * `path` because the default is the route's: `/api/chat` with no `stream` streams NDJSON. Read as
 * non-streamed, such a turn was budgeted as a whole completion rather than a first byte, and held
 * whole to be judged — the caller got nothing until the generation ended, and the NDJSON held could
 * not be judged as one body. Without a path, the OpenAI default.
 */
export function isStreamingRequest(body: unknown, path?: string): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (path !== undefined && STREAMS_BY_DEFAULT_PATHS.has(path)) {
    return body.stream !== false;
  }
  return body.stream === true;
}

/**
 * The context window a request asks its engine for — Ollama's `options.num_ctx` — or `null` when
 * it carries none.
 *
 * Only the native Ollama dialect can say: both agents on the fleet send it there (OpenClaw through
 * `params.num_ctx` on its `api: "ollama"` provider, Hermes through its native adapter), and it is
 * what an engine actually loads the model at. The OpenAI-compatible `/v1` surface has no such field
 * and Ollama ignores one if sent (see `describeFromPeer`'s note on the Hermes probe), so a `/v1`
 * request runs at the serving engine's own default window — which is what the node's cap records.
 * For those, the caller falls back to the prompt estimate; see `applyContextCaps`. Anything but a
 * positive integer is no request, not a tiny one.
 */
export function requestedNumCtx(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.options)) {
    return null;
  }
  const raw = body.options.num_ctx;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
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

/** Requests that spend GPU time on a named model, and so get the Hub's residency arbitration first. */
const GENERATION_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
]);

// ── Serving-node attribution ────────────────────────────────────────────────
//
// Which node ran a routed request used to be knowable only from the routing log — session-gated,
// in-memory, gone on restart — so proving cross-node routing on the fleet meant checking `ollama ps`
// residency on the far side. The decision is stated on the response instead. The values are chosen so
// nothing crosses a boundary it has not already crossed:
//   - the peer's tailnet FQDN is what this Hub holds in its peer row, and the routes carrying it are
//     `InferenceAccessGuard`-gated to apps inside this appliance and to holders of an `inference`
//     key, both of which are already trusted to spend that peer's GPU time;
//   - a request this node served itself says `local`, never this node's own MagicDNS name. `identify`
//     deliberately stopped disclosing that name to unauthenticated callers, and the proxy admits an
//     internal caller by origin alone, so the local case keeps the routing log's `NODE local`
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
 * Response → caller: the routing-log `id` of this request on the Hub that routed it — on a 502 as well
 * as a served response, since a failed call is the one most worth looking up. Request → peer: the same
 * id, so the peer's inbound row carries it and the two nodes' rows for one call join on equality.
 * It names a log row the caller could already read with an operator credential, and nothing else.
 */
export const POOL_REQUEST_ID_HEADER = 'X-Hub-Pool-Request-Id';
/**
 * Response → caller: the status the engine answered with, on a response this Hub relayed under
 * another. Set only on an engine's 500 that proved the request itself was bad (see
 * `hub-pool-request-error.ts`), which goes to the app as a 400 — see {@link relayedRequestErrorStatus}.
 */
export const POOL_UPSTREAM_STATUS_HEADER = 'X-Hub-Pool-Upstream-Status';

/**
 * A peer-supplied request id, or `undefined` when there is none worth keeping.
 *
 * The sender is an authenticated peer, but the value still lands in a log that operators read and
 * scripts parse, so it is held to the shape this Hub mints (a UUID) plus room for another build's
 * choice: 1-64 characters of `[A-Za-z0-9._:-]`, starting alphanumeric. Anything else is dropped and
 * the row gets a fresh id instead, rather than failing a forward over a label.
 */
export function normalizePoolRequestId(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) ? value : undefined;
}
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
export function servedByHeaders(candidate: PoolCandidate, model: string, requestId?: string): Record<string, string> {
  return {
    [POOL_SERVED_BY_HEADER]: candidate.nodeFqdn ?? POOL_SERVED_LOCALLY,
    [POOL_BACKEND_HEADER]: candidate.backend,
    [POOL_MODEL_HEADER]: model,
    ...(requestId ? { [POOL_REQUEST_ID_HEADER]: requestId } : {}),
  };
}
/**
 * The status an engine's refusal of the request goes to the app under, once the walk has ended on it.
 *
 * A 400 rather than the engine's 500, because the status is what an app acts on and the body is what
 * a person reads. The OpenAI SDKs retry any 5xx twice on their own, and OpenClaw reported both of
 * core-2's 2026-09-26 turns as `provider internal error, HTTP 502. This is usually temporary — try
 * again shortly.` Relaying the 500 would have changed only how long that took. A 400 is what the
 * proxy's own failover rule already means by "the request's fault", and the engine's body and its
 * original status (in {@link POOL_UPSTREAM_STATUS_HEADER}) still reach the app.
 *
 * Not for a verdict that may be the node's own fault (`strikesModel`): a template that would not
 * render can be the model's copy, which no change to the request fixes, so it keeps the engine's 500.
 */
export function relayedRequestErrorStatus(verdict: PoolRequestErrorVerdict, upstreamStatus: number): number {
  return verdict.strikesModel ? upstreamStatus : 400;
}
/** 4xx that means "this node can't serve you", never "your request is bad" — retryable on any candidate. */
const TRANSPORT_4XX = new Set([408, 429]);
/**
 * Additionally retryable when the candidate is a *peer*: everything on this list is the peer's own
 * hop answering about the pairing (PoolPeerGuard 401, not-connected 403, a route the peer's build
 * doesn't have 404), not the application's request being wrong — or, for a 401/403 the peer marked
 * as relayed (see {@link isRelayedEngineResponse}), one of its engines refusing its own key.
 */
const PEER_TRANSPORT_4XX = new Set([401, 403, 404, 408, 429]);

/**
 * Whether a peer's response is its ENGINE's answer, relayed, rather than the peer Hub's own.
 *
 * A peer stamps {@link POOL_BACKEND_HEADER} — the engine that answered — on everything it relays from
 * `/inference/pool/local/*` (see `forwardToLocalBackendAndRespond`), and nothing else it sends carries
 * it: its guard and its `forwardLocal` refusals are written before any engine is asked. The sender
 * needs the difference for one reason. A 401 or 403 from the peer Hub means it no longer honours this
 * Hub's pairing, and its cached inventory is stale; the same status from a vLLM, Lemonade or oMLX
 * behind it means THAT engine's key does not match the peer's own setting, which says nothing about
 * the pairing and nothing about the peer's other engines. Reading the second as the first dropped the
 * peer's whole inventory, Ollama models included, over one misconfigured engine.
 *
 * A peer on a build before the stamp sends no mark, so its relayed 401/403 still reads as a pairing
 * refusal — the behaviour every build had until this one.
 */
export function isRelayedEngineResponse(headers: Headers): boolean {
  return headers.has(POOL_BACKEND_HEADER);
}

/** The statuses a peer answers about the pairing itself; see {@link isRelayedEngineResponse} for the one case they are not. */
const PEER_PAIRING_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * How often a peer engine's refusal of its own key is warned about, per peer, engine and status;
 * at debug in between. Unlike a pairing refusal, which drops the peer's capabilities and so stops
 * recurring until the next probe, this one leaves the peer a candidate, so it recurs on every
 * request that ranks it, and agent traffic ranks all day. Each refusal is still in the routing log.
 */
const PEER_ENGINE_REFUSAL_WARN_INTERVAL_MS = 10 * 60_000;

/**
 * How long a request waits in the Hub, with its model's load refused only because other models'
 * generations are running, for those to end (see `PoolProxyService.awaitBusyModels`). The same wait
 * Ollama would impose once the request reached it, but taken here it leaves the busy models alone
 * meanwhile: an engine with a load pending marks the runner it needs to expire at once, so the app
 * streaming on it loses the model at the end of that turn. Bounded, since past it the request is the
 * engine's to arbitrate again, as it always was.
 */
const BUSY_MODEL_WAIT_MS = 60_000;
/** How often the models busy on the engine are looked at while a request waits for them. */
const BUSY_MODEL_POLL_MS = 1_000;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Why the Hub would not load a model on a local engine for a request, and whether that is only because of generations in progress. */
interface LocalLoadRefusal {
  reason: string;
  idleWouldFree: boolean;
}

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
  /** The raw queue depth `score` was built from, which is what prefix affinity judges against its limit. */
  inFlight: number;
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
  const pinned = ordered.filter((candidate) => pinMatches(candidate, pin));
  // Identity-preserving when nothing matched, so "pinned node cannot serve this" and "no pin" are
  // the same list rather than two code paths that could drift.
  return pinned.length === 0 ? ordered : [...pinned, ...ordered.filter((candidate) => !pinMatches(candidate, pin))];
}

/** Whether `candidate` is on the node `pin` names. One predicate, so what a pin moves and what later steps leave alone for it agree. */
function pinMatches(candidate: PoolCandidate, pin: HubPoolPin): boolean {
  return pin.targetKind === 'local' ? candidate.peerId === null : candidate.peerId === pin.peerId;
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

/**
 * Split a ranked list into the candidates whose context cap can take the window the request asks
 * for (`preferred`) and the ones capped below it (`overCap`), each in the order the ranker produced.
 *
 * A node's cap (`inferenceMaxNumCtx`, advertised as `maxNumCtx`) is its operator's statement of the
 * window its engine runs at. A request asking for more reloads that engine's model with the larger
 * window — core-2, 2026-09-20: `ollama ps` 25 GB → 44 GB on a 30B, ~40 s, and a reload back on the
 * next request at the old size — or, on the `/v1` surface where `num_ctx` cannot be sent, has its
 * prompt truncated to the window. So a candidate takes the request only if its cap is unset or at
 * least `numCtx`. This is what lets the handout ask for the fleet's LARGEST window rather than its
 * smallest (see `poolContextCap`): core-17's 16384 no longer decides what ci-hermes on core-2 may
 * ask for, because a 65536 request is simply not placed on core-17 while anything else can take it.
 *
 * The same shape of decision as {@link applyPromptCeiling}, and applied outside it, because both are
 * operator statements and this one is the stronger: an over-ceiling node is slow, an over-cap node
 * reloads or truncates.
 *
 * 1. **It is a preference, not a rule.** An over-cap node is moved to the back, never removed, so a
 *    request still has somewhere to go when every node that can take its window fails. When every
 *    candidate is over its cap nothing moves at all, and `overridden: true` says so.
 * 2. **It never re-orders within either group.** Both halves keep the ranker's order.
 * 3. **Uncapped means any window.** A node that advertises no cap — none set, or a build predating
 *    the field — is never moved back. The placement rule and the handout agree on this, which is
 *    the point: an uncapped node is one the handout may size past every capped node's window.
 *
 * Pure and exported for its own test, like `applyPromptCeiling`.
 */
export function applyContextCap(
  ordered: PoolCandidate[],
  capOf: (candidate: PoolCandidate) => number | null,
  request: { numCtx: number; source: PoolRoutingContextCap['source'] },
): { preferred: PoolCandidate[]; overCap: PoolCandidate[]; decision: PoolRoutingContextCap | null } {
  const caps = ordered.map(capOf);
  if (caps.every((cap) => cap === null)) {
    return { preferred: ordered, overCap: [], decision: null };
  }
  const preferred: PoolCandidate[] = [];
  const overCap: PoolCandidate[] = [];
  const excluded: PoolRoutingContextCapExclusion[] = [];
  for (const [index, candidate] of ordered.entries()) {
    const cap = caps[index] ?? null;
    if (cap === null || request.numCtx <= cap) {
      preferred.push(candidate);
      continue;
    }
    overCap.push(candidate);
    // One entry per node: a node with two engines holding the model is still one node that said no.
    const node = candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY;
    if (!excluded.some((entry) => entry.node === node)) {
      excluded.push({ node, maxNumCtx: cap });
    }
  }
  const overridden = preferred.length === 0;
  const decision = { numCtx: request.numCtx, source: request.source, excluded, overridden };
  return excluded.length === 0 || overridden ? { preferred: ordered, overCap: [], decision } : { preferred, overCap, decision };
}

const NOTHING_DEMOTED: ReadonlySet<PoolCandidate> = new Set();
const NOTHING_DEFERRED: ReadonlyMap<PoolCandidate, UnmeasuredPrior> = new Map();
const NOTHING_MEASURED: ReadonlyMap<PoolCandidate, MeasuredPrefill> = new Map();

/** What {@link applyThroughputPlacement} needs to judge a candidate nothing applicable has been measured on. */
export interface UnmeasuredPlacement {
  /**
   * The prior an unmeasured candidate is judged on, or `null` for one that keeps its place whatever
   * the prompt — see `PoolProxyService.applyMeasuredThroughput` for which those are.
   */
  priorOf: (candidate: PoolCandidate) => UnmeasuredPrior | null;
  /**
   * Which of the outer placement groups — context cap, prompt ceiling, slots — the candidate is ranked
   * in. Throughput reorders only within a group, so an unmeasured candidate gives way only when a
   * candidate measured to meet the budget is ranked in the same one: anywhere else there is nothing
   * for it to go behind, and a row that said it had would be describing a move that never happened.
   */
  groupOf: (candidate: PoolCandidate) => number;
  /**
   * The score the ranker sorted the candidate on: its queue depth, plus the local head start for a
   * peer and the pressure term when that is weighted. An unmeasured candidate gives way only to a
   * measured one scored the same — see {@link applyThroughputPlacement} for why never a busier one.
   */
  scoreOf: (candidate: PoolCandidate) => number;
  /**
   * Whether a candidate measured to meet the budget stays where the steps before contention put it, so
   * that an unmeasured one may give way to it. Not a local engine that contention will move behind the
   * peers no busier than it: giving way to that engine would put those peers behind it first, where
   * contention cannot move it past them, and keep a turn waiting on an engine busy with other work.
   */
  staysInPlace: (candidate: PoolCandidate) => boolean;
}

/** The default: every unmeasured candidate keeps its place, as it did before priors existed. */
const KEEP_UNMEASURED_IN_PLACE: UnmeasuredPlacement = { priorOf: () => null, groupOf: () => 0, scoreOf: () => 0, staysInPlace: () => true };

/** One candidate's prediction, and whether it misses the request's budget. */
export interface MeasuredPrefill {
  prediction: PrefillPrediction;
  slow: boolean;
}

/** What {@link applyThroughputPlacement} decided, for {@link splitByThroughput} to apply to each group. */
export interface ThroughputPlacement {
  /** Measured and predicted to miss the budget: behind every other candidate in their group. */
  demoted: ReadonlySet<PoolCandidate>;
  /** Unmeasured, with the prior each was judged on, and giving way to the candidates measured to meet the budget that the ranker scored the same. */
  deferred: ReadonlyMap<PoolCandidate, UnmeasuredPrior>;
  /** Every candidate with applicable evidence and what it predicts, for {@link applySlowerPlacement} to compare once the order is otherwise final. */
  measured: ReadonlyMap<PoolCandidate, MeasuredPrefill>;
  decision: PoolRoutingThroughput | null;
}

/**
 * Judge each candidate's measured prefill rate against the request's budget. `demoted` is the set of
 * candidates predicted to miss it, to be moved behind every candidate that is not; `deferred` is the
 * unmeasured candidates that, for a prompt this large, give way to one measured to meet it that the
 * ranker holds level with them.
 *
 * The rules are the prompt ceiling's, because the risk is the same — a preference must never become a
 * refusal:
 *
 * 1. **Unmeasured is not known to be fast.** A candidate with no applicable evidence is not in
 *    `estimates`. For a prompt under {@link UNMEASURED_DEFER_MIN_PROMPT_TOKENS} it keeps its place,
 *    which is how it gets measured at all. From that size up, when a candidate in its group that the
 *    ranker scored the same is measured to meet the budget, it goes behind that candidate — and with a
 *    `cpu-only` prior behind the other unmeasured ones scored the same too — but stays ahead of every
 *    candidate predicted to miss, since a measurement that says "too slow" is worse news than no
 *    measurement. Taking it for fast is what sent a 7,731-token turn to core-7 on 2026-09-29: nothing
 *    had timed it, it read the prompt on CPU, and its first byte came after 169.8 s where measured GPU
 *    peers, as idle as it, were predicted at ~32–36 s. With no candidate measured to meet the budget
 *    nothing is deferred, so an unmeasured fleet, or one where every measured node is slow, ranks as
 *    it did before. A candidate whose prior is `null` keeps its place whatever the prompt, and is not
 *    listed.
 * 2. **Never behind a busier candidate.** The ranker's first key is queue depth, and on this fleet's
 *    `-np 1` engines every request queued ahead is a whole turn, ~300 s for a large one — as long as
 *    the CPU read this guards against. So a measurement only settles the ranker's ties: an unmeasured
 *    candidate gives way to a measured one scored the same, never to one scored higher, and keeps its
 *    place ahead of every busier candidate (one scored lower is ranked ahead of it already). A
 *    measured node with a queue therefore does not hold back idle unmeasured peers, and a burst of
 *    large turns spreads over the pool by queue depth as it did before. That is also what keeps the
 *    measured nodes from starving the rest of large turns while evidence ages out
 *    (`THROUGHPUT_FORGET_AFTER_MS`): a node is passed over only while a measured one is exactly as
 *    free, and gets the next turn as soon as that one is not. Nor does anything give way to a
 *    measured candidate contention will move (`staysInPlace` is false).
 * 3. **Demoted or deferred, never removed**, so failover still reaches a slow or unmeasured node when
 *    every other one fails.
 * 4. **All slow means nothing moves.** When every candidate is predicted to miss, `demoted` is empty,
 *    the ranker's order stands, and `overridden: true` says so.
 *
 * A measurement says how fast an engine reads a prompt, not whether what it writes is sound: an engine
 * answering in garbage tokens reaches its first byte as fast as a healthy one and counts here as
 * measured to meet the budget, whether this node timed it or the peer advertised it. Rule 2 bounds what
 * that costs to the ranker's ties; judging output is not this step's job.
 *
 * `decision` is `null` when no candidate had applicable evidence, so a fleet nothing has been timed on
 * gets the list back untouched. Pure and exported for its own test, like `applyPromptCeiling`.
 */
export function applyThroughputPlacement(
  ordered: PoolCandidate[],
  predictionOf: (candidate: PoolCandidate) => PrefillPrediction | null,
  estimatedTokens: number,
  budgetMs: number,
  unmeasured: UnmeasuredPlacement = KEEP_UNMEASURED_IN_PLACE,
): ThroughputPlacement {
  const estimates: PoolRoutingThroughputEstimate[] = [];
  const slow = new Set<PoolCandidate>();
  const measured = new Map<PoolCandidate, MeasuredPrefill>();
  const unmeasuredCandidates: PoolCandidate[] = [];
  // The candidates an unmeasured one is judged beside: the same outer group, and the same ranker
  // score. A newline cannot appear in either number's string form, so no two pairs collide.
  const levelWith = (candidate: PoolCandidate) => `${unmeasured.groupOf(candidate)}\n${unmeasured.scoreOf(candidate)}`;
  const levelsWithAFastCandidate = new Set<string>();
  for (const candidate of ordered) {
    const prediction = predictionOf(candidate);
    if (!prediction) {
      unmeasuredCandidates.push(candidate);
      continue;
    }
    const isSlow = missesBudget(prediction, budgetMs);
    measured.set(candidate, { prediction, slow: isSlow });
    if (isSlow) {
      slow.add(candidate);
    } else if (unmeasured.staysInPlace(candidate)) {
      levelsWithAFastCandidate.add(levelWith(candidate));
    }
    estimates.push({
      node: candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY,
      backend: candidate.backend,
      tokensPerSec: prediction.tokensPerSec,
      fromPromptTokens: prediction.fromPromptTokens,
      extrapolated: prediction.extrapolated,
      predictedMs: prediction.predictedMs,
      source: prediction.source,
      deadline: prediction.deadline,
      slow: isSlow,
    });
  }
  if (estimates.length === 0) {
    return { demoted: NOTHING_DEMOTED, deferred: NOTHING_DEFERRED, measured: NOTHING_MEASURED, decision: null };
  }
  const deferred = new Map<PoolCandidate, UnmeasuredPrior>();
  const deferredEntries: PoolRoutingThroughputUnmeasured[] = [];
  if (estimatedTokens >= UNMEASURED_DEFER_MIN_PROMPT_TOKENS && levelsWithAFastCandidate.size > 0) {
    for (const candidate of unmeasuredCandidates) {
      const prior = unmeasured.priorOf(candidate);
      if (prior === null || !levelsWithAFastCandidate.has(levelWith(candidate))) {
        continue;
      }
      deferred.set(candidate, prior);
      deferredEntries.push({ node: candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY, backend: candidate.backend, prior });
    }
  }
  const overridden = slow.size === ordered.length;
  return {
    demoted: overridden ? NOTHING_DEMOTED : slow,
    deferred,
    measured,
    // `slowerDemoted` is filled in by the caller: which candidate goes first is known only once
    // contention and pins have acted, after this step — see `applySlowerPlacement`.
    decision: { estimatedTokens, budgetMs, estimates, unmeasured: deferredEntries, slowerDemoted: [], overridden },
  };
}

/**
 * One ceiling group split into the candidates expected to meet the budget and the ones that are not,
 * each in the order given. A group with nothing demoted comes back whole, so pins see the exact list
 * they did before throughput existed.
 */
export function splitDemoted(group: PoolCandidate[], demoted: ReadonlySet<PoolCandidate>): PoolCandidate[][] {
  if (!group.some((candidate) => demoted.has(candidate))) {
    return [group];
  }
  return [group.filter((candidate) => !demoted.has(candidate)), group.filter((candidate) => demoted.has(candidate))];
}

/**
 * One group placed by what {@link applyThroughputPlacement} decided. Each unmeasured candidate that
 * gave way moves to just behind the last candidate in the group that `scoreOf` scores the same as it —
 * an `unknown` prior ahead of a `cpu-only` one — which puts it behind the measured candidates it gave
 * way to and keeps it ahead of every busier one. The candidates predicted to miss follow as a part of
 * their own. Everything else keeps the order given, and a group nothing moved in comes back whole, so
 * pins see the exact list they did before throughput existed.
 *
 * The ones that gave way stay in the same part as the ones they gave way to, so local-engine
 * contention, applied within each part, can still move a contended engine behind them. A pin cannot
 * undo the move from there: it only moves its own node, and a pinned node never gives way.
 */
export function splitByThroughput(
  group: PoolCandidate[],
  placement: Pick<ThroughputPlacement, 'demoted' | 'deferred'>,
  scoreOf: (candidate: PoolCandidate) => number,
): PoolCandidate[][] {
  const { demoted, deferred } = placement;
  if (!group.some((candidate) => demoted.has(candidate) || deferred.has(candidate))) {
    return [group];
  }
  const kept = group.filter((candidate) => !demoted.has(candidate));
  const lastAtScore = new Map<number, PoolCandidate>();
  for (const candidate of kept) {
    lastAtScore.set(scoreOf(candidate), candidate);
  }
  const placed: PoolCandidate[] = [];
  const waiting = new Map<number, PoolCandidate[]>();
  for (const candidate of kept) {
    const score = scoreOf(candidate);
    if (deferred.has(candidate)) {
      waiting.set(score, [...(waiting.get(score) ?? []), candidate]);
    } else {
      placed.push(candidate);
    }
    if (lastAtScore.get(score) === candidate) {
      const behind = waiting.get(score) ?? [];
      placed.push(...behind.filter((entry) => deferred.get(entry) === 'unknown'), ...behind.filter((entry) => deferred.get(entry) === 'cpu-only'));
    }
  }
  return [placed, group.filter((candidate) => demoted.has(candidate))].filter((part) => part.length > 0);
}

/** What {@link applySlowerPlacement} needs to know about the candidates of one group. */
export interface SlowerPlacement {
  /** The request's prompt estimate. Nothing moves below {@link UNMEASURED_DEFER_MIN_PROMPT_TOKENS}. */
  estimatedTokens: number;
  /** What {@link applyThroughputPlacement} predicted for the candidate; `undefined` when nothing applicable measured it. */
  measuredOf: (candidate: PoolCandidate) => MeasuredPrefill | undefined;
  /** The queue depth the ranker read for the candidate. */
  inFlightOf: (candidate: PoolCandidate) => number;
  /**
   * Whether the candidate's node advertises a slot count above the queue depth `inFlightOf` reads, so
   * that one request more there runs beside the others rather than waiting for them. `false` for a
   * node that states no count, or an engine whose slots the pool does not read.
   */
  hasFreeSlot: (candidate: PoolCandidate) => boolean;
  /** A candidate that keeps the front when it has it: the pinned node, and the engine prefix affinity holds. */
  holdsFront: (candidate: PoolCandidate) => boolean;
  /** A candidate that may go ahead of the first: not a local engine contention moves behind the peers. */
  mayGoAhead: (candidate: PoolCandidate) => boolean;
  /**
   * An engine withheld for answering with bad output, which the proxy moves behind every other
   * candidate once placement is done: it is neither judged as the first nor brought forward, and
   * keeps its slot here for that later step to move.
   */
  withheld: (candidate: PoolCandidate) => boolean;
  /** {@link SLOWER_PLACEMENT_RATIO}, or its env override. */
  ratio: number;
  /** {@link SLOWER_PLACEMENT_FLOOR_MS}, or its env override. */
  floorMs: number;
}

/**
 * Put the candidates predicted to be much faster than the one about to go first ahead of it, within
 * one group of the final order.
 *
 * Budget demotion only asks whether a node will answer in time, and the budget is sized so that a GPU
 * node reading a large prompt is never mistaken for a dead one, so a CPU node clears it too. Fleet
 * re-bank, 2026-09-30, core-2 entering with 15 leaves: a 35,809-token OpenClaw turn went to core-7,
 * reading on CPU, at a predicted 162,910 ms, while beta-1 was predicted at 22,080 ms, beta-max at
 * 34,651 ms and beta-red at 38,973 ms, all idle; and a 14.5k-token Hermes turn, the local engine moved
 * aside for contention, went to core-7 at 54,854 ms predicted — 57 s to its first byte — while beta-1
 * was predicted at 8,959 ms. The ranker could not see it: the nodes were equally idle, and neither
 * queue depth nor an advertised tier tells a GPU read from a CPU one (core-7 advertises `high`).
 *
 * So when the first candidate has a prediction T1 and a later one T2 with T1 at least `ratio` times
 * T2 and at least `floorMs` longer, the later one goes ahead, provided that it is:
 *
 * - **Measured to meet the budget, on a reading that is not a lower bound.** A missed deadline says
 *   "at least this slow", which says nothing about how much faster than the first it is.
 * - **Measured on what the engine read.** The faster prediction is only as good as the samples under
 *   it, and a turn that reused its prompt from the engine's cache times the cache. When the engine says
 *   how much it reused, a turn's time is charged to the part it read, and a turn that read fewer than
 *   `PREFILL_MIN_READ_TOKENS` is no evidence (see `HubPoolThroughputService.recordPrefill`), so a node
 *   whose only turns were such cache hits is unmeasured here and never goes ahead. A node serving an
 *   agent session's appends stays measured, at the rate of the tokens it read at the end of the
 *   context, which errs slow. An engine that does not say is timed as it always was, and an advertised
 *   rate is the peer's own reading of the same.
 * - **No busier than the first, or one request busier on a node with a slot free for it.** Queue depth
 *   stays the ranker's first key; this settles a tie, or a single request an engine can serve beside
 *   this one, not a queue — see {@link SLOWER_PLACEMENT_MAX_EXTRA_IN_FLIGHT}. Counted from the node the
 *   ranker put first, and from the node being passed when that one is idler, so no chain of moves ends
 *   on a node more than that one request busier than either.
 * - **Not a local engine that contention moves**, which would put it back where contention just took
 *   it from.
 *
 * Every candidate that qualifies goes ahead, keeping the ranker's order among them, and everything
 * else keeps its place behind the first; then the new first is judged the same way, so a turn ends up
 * on a node no candidate is predicted to beat by that much. Each move puts a strictly faster candidate
 * first, so none can lead twice.
 *
 * What it never does:
 *
 * - **Judge an unmeasured candidate.** It is never the first here, nor goes ahead; how unmeasured
 *   peers give way to measured ones is {@link applyThroughputPlacement}'s deferral, and a group led by
 *   one is left alone.
 * - **Move a pinned node or the engine prefix affinity holds from the front** (`holdsFront`). A pin is
 *   the operator's statement and a held engine has the session's prefix warm, where the prediction is
 *   of a cold read.
 * - **Cross a group.** Called within each group the cap, ceiling, slot, budget and contention steps
 *   made, so a node over its cap or ceiling, one whose slots are full, and one predicted to miss the
 *   budget are never brought forward; when every candidate is predicted to miss, none qualifies to go
 *   ahead and the ranker's order stands.
 * - **Count a withheld engine.** One answering with bad output goes behind every other candidate
 *   after this step, so the first candidate judged is the first one not withheld, and a withheld one
 *   is never brought forward, however fast it reads a prompt — a degenerate engine reads as fast as a
 *   sound one. A model an engine has been unable to serve is not a candidate at all.
 * - **Apply to a small prompt.** Below {@link UNMEASURED_DEFER_MIN_PROMPT_TOKENS} the smaller bands
 *   keep reaching a node measured slow, which is how a node whose engine has since moved onto its GPU
 *   gets measured fast again.
 *
 * Pure and exported for its own test. `ordered` is `group` itself when nothing moved.
 */
export function applySlowerPlacement(
  group: PoolCandidate[],
  placement: SlowerPlacement,
): { ordered: PoolCandidate[]; demoted: PoolRoutingThroughputSlowerDemotion[] } {
  const demoted: PoolRoutingThroughputSlowerDemotion[] = [];
  if (group.length < 2 || placement.estimatedTokens < UNMEASURED_DEFER_MIN_PROMPT_TOKENS) {
    return { ordered: group, demoted };
  }
  // Asked once per candidate, so a withhold running out mid-call cannot leave a slot without a candidate.
  const withheld = new Set(group.filter((candidate) => placement.withheld(candidate)));
  let ordered = group.filter((candidate) => !withheld.has(candidate));
  // The queue the ranker chose, read once. Measured from each new first instead, the margin would
  // compound: one move puts a node a request busier first, the next lets a node two busier pass it,
  // and every move stays within the margin of the one before while the turn drifts onto a queue.
  const rankedFirst = ordered[0];
  const rankedInFlight = rankedFirst ? placement.inFlightOf(rankedFirst) : 0;
  // Bounded as well as terminating: each move puts a strictly faster candidate first.
  for (let moves = 0; moves < group.length; moves += 1) {
    const [first, ...rest] = ordered;
    const firstMeasured = first ? placement.measuredOf(first) : undefined;
    if (!first || !firstMeasured || placement.holdsFront(first)) {
      break;
    }
    const slowerMs = firstMeasured.prediction.predictedMs;
    // The idler of the ranker's first and the node being passed. A move can put a node idler than the
    // ranker's first in front; whatever passes it then is held to its queue too, so no move is ever to
    // a node more than the margin busier than the one it passes.
    const level = Math.min(rankedInFlight, placement.inFlightOf(first));
    const faster = rest.filter((candidate) => {
      const measured = placement.measuredOf(candidate);
      if (!measured || measured.slow || measured.prediction.deadline) {
        return false;
      }
      if (!placement.mayGoAhead(candidate)) {
        return false;
      }
      const inFlight = placement.inFlightOf(candidate);
      if (inFlight > level && !(inFlight <= level + SLOWER_PLACEMENT_MAX_EXTRA_IN_FLIGHT && placement.hasFreeSlot(candidate))) {
        return false;
      }
      const fasterMs = measured.prediction.predictedMs;
      return fasterMs < slowerMs && slowerMs >= placement.ratio * fasterMs && slowerMs - fasterMs >= placement.floorMs;
    });
    const ahead = faster[0];
    const aheadMeasured = ahead ? placement.measuredOf(ahead) : undefined;
    if (!ahead || !aheadMeasured) {
      break;
    }
    demoted.push({
      node: first.nodeFqdn ?? LOCAL_CANDIDATE_KEY,
      backend: first.backend,
      predictedMs: slowerMs,
      inFlight: placement.inFlightOf(first),
      fasterNode: ahead.nodeFqdn ?? LOCAL_CANDIDATE_KEY,
      fasterBackend: ahead.backend,
      fasterMs: aheadMeasured.prediction.predictedMs,
      fasterInFlight: placement.inFlightOf(ahead),
    });
    const movedAhead = new Set(faster);
    ordered = [...faster, first, ...rest.filter((candidate) => !movedAhead.has(candidate))];
  }
  // The list is also the failover walk, which the first candidate failing sends the request down, and
  // judging only the first left the node it displaced second, ahead of every node that rule passed over
  // for being busier. The rest is judged the same way, from the node the ranker put first of it, and its
  // moves are not logged: the log names the node that goes first. A first that is unmeasured or holds
  // the front leaves the whole list alone, as it does for its own move.
  const lead = ordered[0];
  const rest = ordered.slice(1);
  const walked = lead && placement.measuredOf(lead) && !placement.holdsFront(lead) ? applySlowerPlacement(rest, placement).ordered : rest;
  const walkMoved = walked !== rest;
  if (walkMoved && lead) {
    ordered = [lead, ...walked];
  }
  if (demoted.length === 0 && !walkMoved) {
    return { ordered: group, demoted };
  }
  // Back into the slots the candidates judged came from, around the withheld ones.
  const placed: PoolCandidate[] = [];
  let next = 0;
  for (const candidate of group) {
    const slot = withheld.has(candidate) ? candidate : ordered[next++];
    if (slot) {
      placed.push(slot);
    }
  }
  return { ordered: placed, demoted };
}

/** What slot-aware placement knows about one candidate: the queue depth the ranker sorted on, and the slots its node advertised. */
export interface SlotOccupancy {
  inFlight: number;
  slots: number;
}

/**
 * The engines whose concurrency IS a slot count the pool can place against: Ollama, by its
 * operator's statement (`inferenceOllamaSlots`), and llama-server, which runs `-np` slots and says
 * so on `/props` (`total_slots`) — a local one is read from its own statement, a peer's through the
 * node's `ollamaSlots`, which `cihub fleet backends --backends llamacpp` writes from the same
 * number. Every other engine keeps its place, as before slots existed.
 */
export const SLOT_STATED_BACKENDS: ReadonlySet<InferenceBackendType> = new Set<InferenceBackendType>(['ollama']);

/**
 * Judge each Ollama or llama-server candidate's known queue depth against the slot count its node
 * advertised (`inferenceOllamaSlots`, the operator's statement of `OLLAMA_NUM_PARALLEL`; for a local
 * llama-server its own `total_slots`). `demoted` is the set of candidates whose queue already fills
 * their slots, to be moved behind every candidate that still has one free — because past that point
 * the engine queues the request behind itself rather than serving it (measured 2026-09-21: 5–10 s
 * to the first token on a full 2-slot node while 4-slot nodes sat idle).
 *
 * The rules are the prompt ceiling's and the throughput placement's, because the risk is the same —
 * a preference must never become a refusal:
 *
 * 1. **Unstated is neither full nor free.** A candidate whose node advertises no slot count, or whose
 *    engine is not one of {@link SLOT_STATED_BACKENDS}, is never demoted and keeps its place relative
 *    to the ones that are not.
 * 2. **Demoted, never removed**, so failover still reaches a full node when every free one fails.
 * 3. **All full means nothing moves.** When every candidate is at or over its slots, `demoted` is
 *    empty, the ranker's order stands, and `overridden: true` says so.
 *
 * The queue depth judged is the one the ranker sorted on — for a peer what this node has forwarded it
 * plus what it reported beyond those forwards, or the neutral assumed load when its snapshot is stale — so a
 * 1-slot peer that cannot be measured counts as full: an unmeasured node is never taken for an idle
 * one. `decision` is `null` when no candidate carried a slot count, so a fleet that never states one
 * gets the list back untouched. Pure and exported for its own test, like `applyPromptCeiling`.
 */
export function applySlotPlacement(
  ordered: PoolCandidate[],
  occupancyOf: (candidate: PoolCandidate) => SlotOccupancy | null,
): { demoted: ReadonlySet<PoolCandidate>; decision: PoolRoutingSlots | null } {
  const full = new Set<PoolCandidate>();
  const demoted: PoolRoutingSlotDemotion[] = [];
  let stated = 0;
  for (const candidate of ordered) {
    const occupancy = occupancyOf(candidate);
    if (!occupancy) {
      continue;
    }
    stated += 1;
    if (occupancy.inFlight < occupancy.slots) {
      continue;
    }
    full.add(candidate);
    demoted.push({
      node: candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY,
      backend: candidate.backend,
      inFlight: occupancy.inFlight,
      slots: occupancy.slots,
    });
  }
  if (stated === 0) {
    return { demoted: NOTHING_DEMOTED, decision: null };
  }
  const overridden = full.size === ordered.length;
  return { demoted: overridden ? NOTHING_DEMOTED : full, decision: { demoted, overridden } };
}

/**
 * The engines that load a model at the window a request asks for, so that one request at another
 * window than the requests already running must wait for them and reload: Ollama, whose `num_ctx` is
 * a load parameter. Every other engine runs the window it was started with, whatever a request names.
 */
const WINDOW_RELOADING_BACKENDS: ReadonlySet<InferenceBackendType> = new Set<InferenceBackendType>(['ollama']);

/** Sentinel a residency read's placement budget resolves to, distinct from any answer the engine gives — see `prefixCanStillBeWarm`. */
const RESIDENCY_BUDGET_ELAPSED = Symbol('residency budget elapsed');

/** The window a request runs at when it names one: `options.num_ctx` on Ollama's native routes, never on `/v1`, where Ollama drops `options` and its default applies. */
function requestedWindow(path: string, body: unknown): number | null {
  return path.startsWith('/api/') ? requestedNumCtx(body) : null;
}

/** A window as `cihub pool log` words it: `null` is a request that named none on a node that states no default. */
function describeWindow(numCtx: number | null): string {
  return numCtx === null ? 'the engine default' : `num_ctx ${numCtx}`;
}

/** What contention placement found on one local engine: the generations in flight there that a request placed on it could not join. */
interface LocalEngineContention {
  /** Each distinct model and window among them, the window resolved as the engine runs it — see {@link PoolRoutingContentionDemotion.busyWith}. */
  busyWith: { model: string; numCtx: number | null }[];
  /** The window the request would run at there. */
  runsAt: number | null;
}

/**
 * Move each contended local engine behind the candidates right after it that are no busier than it
 * once its local head start is set aside, stopping at the first one that is busier.
 *
 * A contended engine is generating for work the request cannot join: another model's turn, which
 * Ollama must evict behind or share the engine with, or this model's at another window, which it must
 * wait out and reload for. beta-max, 2026-09-26: a 35b turn at `num_ctx` 65536 waited behind two
 * `/v1` requests for 35b at the 32768 default, then behind an eviction of 27b, whose 39,668-token
 * prefill took 362 s because it shared the engine with 35b, and failed over at its 327 s budget.
 *
 * The local head start (`poolLocalAffinity`) pays for a prompt cache a turn here reuses. A reload
 * discards it and a shared engine reads far slower (that 35b: 1,019 tok/s alone, 174 beside 27b), so
 * a contended engine forfeits the head start and loses ties. It never gives way to a busier
 * candidate: both fleet models run `-np 1`, so a peer with eight in flight is eight turns in a row.
 *
 * Demoted, never removed, as for slots, and among contended engines nothing moves. `pieces` splits
 * the group before each engine that gave way, so a pin applied within a piece cannot undo it;
 * `behind` names what each contended engine gave way to, empty when it kept its place. Pure and
 * exported for its own test.
 */
export function applyLocalContention(
  group: PoolCandidate[],
  isContended: (candidate: PoolCandidate) => boolean,
  scoreOf: (candidate: PoolCandidate) => number,
  headStart: number,
): { pieces: PoolCandidate[][]; behind: Map<PoolCandidate, PoolCandidate[]> } {
  const behind = new Map<PoolCandidate, PoolCandidate[]>();
  const pieces: PoolCandidate[][] = [[]];
  // Contended engines not yet placed, in ranked order. Every one of them is local, so they share a
  // score, and the first one's limit is theirs.
  let waiting: PoolCandidate[] = [];
  let limit = 0;
  const place = () => {
    if (waiting.some((candidate) => (behind.get(candidate)?.length ?? 0) > 0)) {
      pieces.push([]);
    }
    pieces[pieces.length - 1]?.push(...waiting);
    waiting = [];
  };
  for (const candidate of group) {
    if (isContended(candidate)) {
      if (waiting.length === 0) {
        limit = scoreOf(candidate) + headStart;
      }
      waiting.push(candidate);
      behind.set(candidate, []);
      continue;
    }
    if (waiting.length > 0 && scoreOf(candidate) > limit) {
      place();
    }
    for (const contended of waiting) {
      behind.get(contended)?.push(candidate);
    }
    pieces[pieces.length - 1]?.push(candidate);
  }
  place();
  return { pieces: pieces.filter((piece) => piece.length > 0), behind };
}

/** What one forwarded response revealed about its engine's speed, gathered while it streams. */
interface ResponseTiming {
  firstChunkAt: number | null;
  completedAt: number | null;
  engine: EngineTimings | null;
  usage: PoolRoutingUsage | null;
  /** How much of the prompt the engine read rather than took from its cache, when it said. */
  promptRead: PromptRead | null;
}

function startResponseTiming(): { timing: ResponseTiming; observer: ResponseTapObserver } {
  const timing: ResponseTiming = { firstChunkAt: null, completedAt: null, engine: null, usage: null, promptRead: null };
  return {
    timing,
    observer: {
      onFirstChunk: () => {
        timing.firstChunkAt = Date.now();
      },
      onComplete: () => {
        timing.completedAt = Date.now();
      },
      onEngineTimings: (engine) => {
        timing.engine = engine;
      },
      onPromptRead: (read) => {
        timing.promptRead = read;
      },
    },
  };
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
 * The response's one close watch (see `watchResponseClose`): `clientClosed` fires when `res`'s
 * connection closes before the response was finished. Keyed on `writableFinished`, because a
 * response that completed normally closes too. Attach it before the first `await` of a handler, so a
 * client that leaves while candidates are still being ranked is not missed, and dispose of it once
 * the handler has settled.
 *
 * And keyed on `errored`, because a client leaving is not the only way `res` closes unfinished:
 * when the ENGINE dies mid-stream, the relay destroys `res` with the engine's error, which closes it
 * too. Without that check the catch blocks read their own teardown as a hang-up — measured against a
 * real socket, an engine that dropped its connection mid-generation was logged at debug as "client
 * closed a streaming response", the candidate-failure warning never appeared, and the peer-facing
 * forward swallowed the error instead of surfacing it. A client that disconnects leaves `errored`
 * null: Node closes the response from the socket, not through `destroy(err)`.
 *
 * One listener for the whole request, however many candidates it walks — every forward shares its
 * signal, and the relay hears the close through it rather than adding `pipeline`'s seven.
 */
function watchClient(res: Response): ResponseCloseWatch {
  return watchResponseClose(res, CLIENT_CLOSED_MESSAGE);
}

/** Longest attempt reason kept on a routing row: a status, a deadline or an error code, never a paragraph. */
const MAX_ATTEMPT_REASON_CHARS = 200;

/**
 * Why a forward failed without an answer, in the few words a routing row keeps: the deadline that
 * expired, or the transport error and its code. A `fetch` failure's own message is only "fetch
 * failed"; the code on its `cause` is the part an operator can act on.
 */
export function describeAttemptError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : error == null ? 'unknown error' : typeof error === 'object' ? safeJson(error) : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  const code = typeof cause?.code === 'string' && !message.includes(cause.code) ? ` (${cause.code})` : '';
  const text = `${message}${code}`;
  return text.length > MAX_ATTEMPT_REASON_CHARS ? `${text.slice(0, MAX_ATTEMPT_REASON_CHARS - 1)}…` : text;
}

/**
 * An `attempts` reason for a local engine passed over because the Hub refused to load the model there.
 * The Hub's own sentence: sizes and what it could not unload, or, for a load the engine failed, the
 * engine's error about that load, which carries no prompt. Kept to the length of every other attempt
 * reason; the log line written beside it carries it whole.
 */
function describeLocalLoadRefusal(refusal: string): string {
  const text = `local load refused: ${refusal}`;
  return text.length > MAX_ATTEMPT_REASON_CHARS ? `${text.slice(0, MAX_ATTEMPT_REASON_CHARS - 1)}…` : text;
}

/** A routing row's reason for an answer that was an error status, with the engine's verdict label when one was read. */
function describeStatusReason(status: number, signature?: string): string {
  return signature ? `HTTP ${status} (${signature})` : `HTTP ${status}`;
}

/**
 * The model a peer's forward is for: the `X-Hub-Pool-Model` it sent, or else the forwarded body's own
 * `model`. The body is already parsed by the time the route runs; reading one field of it holds
 * nothing the relay does not already hold.
 */
export function forwardedModel(header: string | undefined, body: unknown): string | undefined {
  if (header) return header;
  return isRecord(body) && typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;
}

/**
 * A non-streamed body read whole before anything is sent, so it can be judged — and, if the engine's
 * answer was cut off or degenerate, not sent at all while another candidate can still be asked. `text`
 * is `null` when the body ran past `maxBytes`: it is then relayed unjudged. `body` replays what was
 * read and then whatever is left, so the caller gets every byte either way.
 */
async function holdWholeBody(
  source: WebReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ body: WebReadableStream<Uint8Array>; text: string | null }> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return { body: replayBody(chunks, null), text: Buffer.concat(chunks).toString('utf8') };
    }
    chunks.push(next.value);
    size += next.value.byteLength;
    if (size > maxBytes) {
      return { body: replayBody(chunks, reader), text: null };
    }
  }
}

function replayBody(chunks: Uint8Array[], rest: ReadableStreamDefaultReader<Uint8Array> | null): WebReadableStream<Uint8Array> {
  let index = 0;
  return new WebReadableStream<Uint8Array>({
    pull: async (controller) => {
      const held = chunks[index];
      if (held) {
        index += 1;
        controller.enqueue(held);
        return;
      }
      const next = rest ? await rest.read() : null;
      if (!next || next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel: (reason) => rest?.cancel(reason),
  });
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

/**
 * What one of this node's own backends said when asked about a model — kept for the 502 that has
 * no candidate to name, because "no pool node has it" was, on a fleet node, most often "this
 * node has it and the Hub container cannot reach the engine": vLLM behind a firewall rule that
 * only allowed Ollama's port, Lemonade published on the tailscale address only. Every one of
 * those read as an inventory problem until someone probed from inside the container by hand.
 */
export interface LocalBackendProbe {
  type: InferenceBackendType;
  /** The URL the Hub probed — the container's view, which is the one that matters. */
  url: string;
  running: boolean;
  healthy: boolean;
  /** Whether the inventory named the requested model (regardless of health). */
  listsModel: boolean;
  error?: string;
  /**
   * How old this answer was when the request read it. Placement reads a snapshot (see
   * `HubPoolLocalHealthService`), so an operator comparing this body with an engine they just
   * fixed needs to know whether they are looking at a live probe or one from before the fix.
   */
  probedMsAgo: number;
}

export function describeNoCandidates(model: string, pin: HubPoolPin | null, probes: LocalBackendProbe[] = []): string {
  const base = `No pool node currently has model "${model}" available.`;
  const local = describeLocalProbes(probes);
  if (!pin) {
    return local ? `${base} ${local}` : base;
  }
  const target = pin.targetKind === 'local' ? 'this Hub' : 'a peer';
  const scope = pin.scope === 'model' ? `"${model}" is pinned` : 'Routing is pinned';
  // "either" is load-bearing: a prefer pin never removes a candidate, so the pinned node not being
  // able to serve the model is one fact about an empty list, not the cause of it.
  const pinned = `${base} ${scope} to ${target}, which cannot serve it either — the pin only reorders candidates, so this is an inventory problem, not a pin one.`;
  return local ? `${pinned} ${local}` : pinned;
}

/**
 * The local half of a no-candidate 502, in prose only where it is precise: a backend that answered
 * but was left out (a foreign engine on a shared port, a server without weights, a model it has
 * been failing to serve) is named with its reason; the unreachable ones are pointed at, not
 * listed, because six "connection refused" lines say less than one probe from inside the container.
 */
/** A backend's probe URL for the 502 body; never lets a URL resolver's own failure mask the health answer. */
function safeBaseUrl(backend: { getBaseUrl(): string }): string {
  try {
    return backend.getBaseUrl();
  } catch {
    return '';
  }
}

function describeLocalProbes(probes: LocalBackendProbe[]): string {
  if (probes.length === 0) return '';
  const excluded = probes
    .filter((probe) => probe.running && (!probe.healthy || probe.listsModel) && probe.error)
    .map((probe) => `local ${probe.type} at ${probe.url} answered but was left out: ${probe.error}`);
  const unreachable = probes.filter((probe) => !probe.running).map((probe) => probe.type);
  const parts = [...excluded];
  if (unreachable.length > 0) {
    parts.push(
      `local ${unreachable.join(', ')} not reachable from inside the Hub container — if one of them serves this model on the host, ` +
        'it must listen on an address the container can reach (see `localBackends` in this response for each URL and error)',
    );
  }
  return parts.length ? `${parts.join('; ')}.` : '';
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
 * retrying a malformed request on a different machine just wastes a hop — and
 * so is a 500 whose body is an engine's known verdict on the request (see
 * `hub-pool-request-error.ts`), after one more candidate agrees where a single
 * node's word is not enough and no candidate still ahead could answer otherwise.
 *
 * Failover stops the instant a response is committed: once status and headers
 * have gone to the client, a second candidate has nowhere to write.
 *
 * A 200 is not taken on trust either (see `hub-pool-output-check.ts`): a
 * non-streamed completion that was cut off or is only placeholder tokens fails
 * over like a 5xx, a stream that turns out so is recorded as the node failing
 * it, and an engine that does either twice in five minutes is tried last for a
 * cooldown.
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
    // Optional for the same positional reason. A harness that passes none still measures and places,
    // against a store of its own; Nest always injects the module's one, which the peer service
    // advertises and reports from.
    @Optional() throughput?: HubPoolThroughputService,
    // Optional for the same positional reason, and before the router so that one keeps the last
    // slot the constructor-shape test pins. A harness that passes none gets a snapshot of its own
    // over the same registry and settings, which is all Nest's would be.
    @Optional() localHealth?: HubPoolLocalHealthService,
    // Appended last and optional for the same positional reason. #1483 took the router out of
    // `auto` resolution, which now runs against the whole pool; residency arbitration
    // (`arbitrateLocalLoad`, through `loadTrackedModel`) is a separate job and is the only thing left
    // that reads it. Without it, or without the model registry arbitration finds the model in, a
    // local generation still forwards, just without the keep-resident/evict step.
    @Optional() @Inject(forwardRef(() => InferenceRouterService)) private readonly router?: InferenceRouterService,
  ) {
    this.throughput = throughput ?? new HubPoolThroughputService();
    this.localHealth = localHealth ?? new HubPoolLocalHealthService(backends, configuration);
  }

  private readonly throughput: HubPoolThroughputService;
  private readonly localHealth: HubPoolLocalHealthService;
  /** Where each recent prompt prefix was last placed — see `hub-pool-prefix-affinity.ts`. */
  private readonly prefixAffinity = new PrefixAffinityStore();
  /** When each peer engine's key refusal was last warned about — see {@link warnPeerEngineRefusal}. Bounded by peers × engines × two statuses. */
  private readonly peerEngineRefusalWarnedAt = new Map<string, number>();
  /**
   * Engines that have been answering 200 with cut-off or degenerate output, and are withheld from the
   * front of the walk for a cooldown — see `hub-pool-output-check.ts`. Per node, engine and model.
   */
  private readonly outputQuarantine = new PoolOutputQuarantine();

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
   * This node's models as {@link probeLocalCandidates} would offer them: healthy, running backends only,
   * minus anything a backend has withheld. The two must agree, or `auto` could resolve to a model
   * that then has no local candidate.
   */
  private async localServableInventory(): Promise<NodeModelInventory> {
    const backends = (await this.localHealth.read())
      .filter(({ health }) => health.running && health.healthy)
      .map(({ type, health }) => ({ type, models: health.modelsLoaded.filter((id) => !inventoryListsModel(health.unservableModels, id)) }));
    return { local: true, backends };
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

  /** Read per request, like {@link localAffinity}. `0` (the default) keeps affinity out of ranking entirely, and no prefix is hashed or remembered — see {@link rankCandidates}. */
  private prefixAffinityMaxInFlight(): number {
    return this.configuration.getHubPoolPreferences().poolPrefixAffinityMaxInFlight;
  }

  /** Read per request: relative affinity margin to prevent prefix thrashing under high concurrency. */
  private prefixAffinityMargin(): number {
    return this.configuration.getHubPoolPreferences().poolPrefixAffinityMargin;
  }

  /** Read per request, like {@link localAffinity}. `0` (the default) keeps slot counts out of ranking entirely — see {@link applyAdvertisedSlots}. */
  private slotAwareness(): number {
    return this.configuration.getHubPoolPreferences().poolSlotAwareness;
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
   * Then prefix affinity, when the request carries a session key and `poolPrefixAffinityMaxInFlight`
   * is above zero: the node and engine that last served this prefix move to the front while their
   * queue is under the limit — see {@link applyPrefixAffinity}. Applied before every step below, so
   * each of them still wins over it, except local-engine contention, which leaves the engine it
   * qualified in place while the session's prefix can still be warm there.
   *
   * Then the context caps, when `promptBytes` is given: a node whose cap is below the window the
   * request asks for — `numCtx` when the body carried `options.num_ctx`, else the prompt estimate —
   * moves behind every node that can take it, keeping its place in the failover walk — see
   * {@link applyContextCap}.
   *
   * Then the prompt ceilings, within each of those groups: a node whose ceiling is below the
   * request's estimate moves behind every node that is not — see {@link applyPromptCeiling}.
   *
   * Then slot-aware placement, within each of those groups and only with `poolSlotAwareness` on: an
   * Ollama candidate whose known queue depth already fills the slots its node advertised moves behind
   * every candidate that still has one free — see {@link applySlotPlacement}. Judged on every route
   * that occupies a slot, body or not, because `OLLAMA_NUM_PARALLEL` queues an embedding exactly as
   * it queues a turn; the one caller that occupies none — the peer `/api/show` lookup in
   * {@link describeFromPeer}, answered from metadata on disk — says so and is not judged. Inside
   * the ceiling because the ceiling is an operator's statement about a prompt and this is an
   * inference about a queue; outside throughput because a full engine queues the request whole,
   * where a slow one merely reads it slowly. At 0, the shipped default, nothing here is read.
   *
   * Then measured throughput, within each of those groups: a candidate whose measured prefill rate
   * would take it past the request's budget moves behind the ones that would not, and for a large
   * prompt a peer nothing has measured moves behind the ones measured to meet it that are exactly as
   * busy, never a busier one, and never an engine contention is about to move — see
   * {@link applyThroughputPlacement}. `streaming` picks the budget, as it does for the forward.
   *
   * Then local-engine contention, within each of those groups and only for a generation with a peer
   * to go to: a local engine generating for work this request cannot join — another model, or this
   * one at another window — gives up the local head start and moves behind the candidates after it
   * that are no busier — see {@link applyLocalContention}. Inside throughput, unlike slots: a node
   * measured too slow misses its whole budget, while a contended engine may only be waiting out a
   * turn that is nearly done. The one engine exempt is the one prefix affinity qualified, while the
   * session's prefix can still be warm there: a cold prefill elsewhere costs more than sharing the
   * engine, but a reload behind this model at another window, or a model no longer resident, has
   * discarded the prefix and makes the turn wait as well — see {@link prefixCanStillBeWarm}.
   *
   * An operator pin is applied next, within each of the resulting groups — see {@link applyPin}. It
   * reorders; it cannot admit a node the steps above excluded.
   *
   * Last, within each of those groups and for a large prompt only: when the candidate the group would
   * try first is predicted {@link SLOWER_PLACEMENT_RATIO} times and {@link SLOWER_PLACEMENT_FLOOR_MS}
   * slower than another measured to meet the budget, and that one is no busier than the ranker's first
   * (or one request busier on a node advertising a slot free for it), the faster one goes ahead — see
   * {@link applySlowerPlacement}. Meeting the budget is a low bar that a CPU node can clear, and this
   * is what stops a turn waiting minutes on one while a GPU node as idle would answer in seconds. Last
   * because it needs the final first candidate, and never moves the pinned node or the engine prefix
   * affinity holds from the front.
   */
  async buildCandidateList(model: string, promptBytes?: number, streaming = true, numCtx: number | null = null): Promise<PoolCandidate[]> {
    return (await this.rankCandidates(model, promptBytes === undefined ? undefined : { bytes: () => promptBytes, streaming, numCtx: () => numCtx }))
      .candidates;
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
     * The forwarded payload's size, measured only if some candidate has a ceiling or applicable
     * throughput evidence: that is one more serialisation of what can be a 184 KB agent turn, and a
     * fleet with neither should not pay it. Absent means "no body to judge", and both steps are skipped.
     */
    prompt?: {
      bytes: () => number;
      streaming: boolean;
      /** The request's session key, derived only if affinity is on — a header read, else one SHA-256 over the prompt's head, but not for a fleet that has it off. */
      prefixKey?: () => PrefixKey | null;
      /** The window the body asks for (`options.num_ctx`), read only if some candidate has a cap; `null` when it carries none. */
      numCtx?: () => number | null;
    },
    /**
     * Whether the request being placed will occupy one of the engine's `OLLAMA_NUM_PARALLEL` slots.
     * Every forwarded request does — a turn and an embedding alike — so this defaults on; a
     * metadata lookup does not, and passing `false` keeps {@link applySlotPlacement} out of its
     * ranking so a full node is still asked first when it is the one best placed to answer.
     */
    occupiesSlot = true,
  ): Promise<{
    candidates: PoolCandidate[];
    pin: HubPoolPin | null;
    promptCeiling: PoolRoutingPromptCeiling | null;
    contextCap: PoolRoutingContextCap | null;
    slots: PoolRoutingSlots | null;
    throughput: PoolRoutingThroughput | null;
    contention: PoolRoutingContention | null;
    /** What affinity saw and did, and the key to remember the placement under; both `null` when affinity did not apply. */
    affinity: { decision: PoolRoutingAffinity | null; key: PrefixKey | null };
    /** The peer rows ranking read, so placement-time checks see the same snapshot the order came from. */
    peers: HubPoolPeer[];
    /** What each local backend said — the no-candidate 502 reports these. */
    localProbes: LocalBackendProbe[];
  }> {
    const [{ candidates: local, probes: localProbes }, peers] = await Promise.all([this.probeLocalCandidates(model), this.usablePeers()]);
    const weight = this.pressureWeight();
    const localPressure = this.pressureService.band() ?? UNKNOWN_PRESSURE;
    const localInFlight = this.loadService.localInFlight();
    const localScore = localInFlight + weight * localPressure;
    const ranked: RankedCandidate[] = [
      ...local.map((candidate) => ({ candidate, score: localScore, inFlight: localInFlight, pressure: localPressure, tierRank: LOCAL_TIER_RANK })),
      ...this.peerCandidates(model, peers, weight),
    ];
    // Stable sort: candidates that tie on every key keep insertion order — local backends in
    // INFERENCE_BACKEND_TYPES order, then peers in the order the repository returned them.
    //
    // `weight ? … : 0` rather than always comparing: at weight 0 the middle key must not exist, or a
    // measured node would start winning ties that a static hardware tier decides today.
    ranked.sort((a, b) => a.score - b.score || (weight ? a.pressure - b.pressure : 0) || a.tierRank - b.tierRank);
    const affinity = this.applyRememberedPlacement(ranked, prompt?.prefixKey);
    const ordered = affinity.ordered.map((entry) => entry.candidate);
    // Shared, so the three prompt-size decisions cost one serialisation between them at most.
    const measurePromptBytes = prompt ? memoize(prompt.bytes) : undefined;
    const cap = measurePromptBytes
      ? this.applyContextCaps(model, ordered, peers, measurePromptBytes, prompt?.numCtx)
      : { preferred: ordered, overCap: [], decision: null };
    const ceiling = measurePromptBytes
      ? this.applyPromptCeilings(model, ordered, peers, measurePromptBytes)
      : { preferred: ordered, overCeiling: [], decision: null };
    const slots = occupiesSlot ? this.applyAdvertisedSlots(model, affinity.ordered, peers) : { demoted: NOTHING_DEMOTED, decision: null };
    // Read from the same in-memory settings object every other pool knob comes from, so a pin takes
    // effect on the next request and costs no query on the inference hot path. Read before throughput,
    // which leaves a pinned node in place when nothing has measured it.
    const pin = resolvePinFor(this.configuration.getHubPoolPreferences().poolPins, model);
    const overCap = new Set(cap.overCap);
    const overCeiling = new Set(ceiling.overCeiling);
    // Judged, like throughput, only on the routes `prompt` is passed for: a turn is what a reload
    // behind another turn, or an engine shared with one, can keep waiting for minutes. Judged before
    // throughput, which must know which engines contention will move.
    const contended = prompt ? this.judgeLocalContention(model, ordered, prompt.numCtx) : null;
    const scores = new Map(affinity.ordered.map((entry) => [entry.candidate, entry.score]));
    const scoreOf = (candidate: PoolCandidate) => scores.get(candidate) ?? 0;
    const headStart = this.localAffinity();
    const gaveWayTo = new Map<PoolCandidate, PoolCandidate[]>();
    // The engine affinity qualified is exempt while the session's prefix can still be warm on it:
    // that prefix is worth more than a turn beside another model costs — see the header of
    // `hub-pool-prefix-affinity.ts` — but only while it is there, which contention is exactly when it
    // may not be (see `prefixCanStillBeWarm`). `heldByAffinity` records that the exemption changed
    // something, so the log does not credit affinity with an engine that every candidate after it was
    // busier than anyway.
    const heldEngine = affinity.held ? contended?.engines.get(affinity.held) : undefined;
    const held = affinity.held && heldEngine && (await this.prefixCanStillBeWarm(model, affinity.held, heldEngine)) ? affinity.held : null;
    // Not an engine contention will move: every contended one but the engine held for affinity, the
    // predicate `giveWay` below applies. Neither an unmeasured peer nor the first of a group gives way
    // to one of those, since contention would then leave the turn waiting on it.
    const staysInPlace = (candidate: PoolCandidate) => candidate === held || !contended?.engines.has(candidate);
    const throughput: ThroughputPlacement =
      prompt && measurePromptBytes
        ? this.applyMeasuredThroughput(model, ordered, peers, measurePromptBytes, prompt.streaming, {
            // The group the three outer splits below put a candidate in, so an unmeasured one gives way
            // only to a measured one it is ranked beside.
            groupOf: (candidate) => (overCap.has(candidate) ? 4 : 0) + (overCeiling.has(candidate) ? 2 : 0) + (slots.demoted.has(candidate) ? 1 : 0),
            scoreOf,
            staysInPlace,
            pinned: (candidate) => pin !== null && pin.targetKind === 'peer' && candidate.peerId === pin.peerId,
            held: affinity.held,
          })
        : { demoted: NOTHING_DEMOTED, deferred: NOTHING_DEFERRED, measured: NOTHING_MEASURED, decision: null };
    let heldByAffinity = false;
    const giveWay = (part: PoolCandidate[]): PoolCandidate[][] => {
      if (!contended || !part.some((candidate) => contended.engines.has(candidate))) {
        return [part];
      }
      if (held && contended.engines.has(held) && part.includes(held)) {
        const unheld = applyLocalContention(part, (candidate) => contended.engines.has(candidate), scoreOf, headStart);
        heldByAffinity = (unheld.behind.get(held)?.length ?? 0) > 0;
      }
      const result = applyLocalContention(part, (candidate) => candidate !== held && contended.engines.has(candidate), scoreOf, headStart);
      for (const [candidate, ahead] of result.behind) {
        gaveWayTo.set(candidate, ahead);
      }
      return result.pieces;
    };
    // Last within each group, after contention and the pin, because only then is it known which
    // candidate a group would try first — see `applySlowerPlacement`.
    const inFlight = new Map(affinity.ordered.map((entry) => [entry.candidate, entry.inFlight]));
    const thresholds = slowerPlacementThresholds();
    // Asked of the same quarantine `demoteWithheldEngines` reads just after, and not at all while it is empty.
    const quarantineEmpty = this.outputQuarantine.isEmpty();
    const slowerDemoted: PoolRoutingThroughputSlowerDemotion[] = [];
    // Read with slot awareness off too, its shipped default: that knob decides whether a full engine
    // is moved back, while this only decides whether a faster node one request busier may go ahead,
    // and without it the margin would queue a turn behind a whole turn on a `-np 1` engine. Built the
    // first time a candidate that much busier is weighed, which most requests never reach.
    const slotsOf = memoize(() => this.advertisedSlotsOf(peers));
    const hasFreeSlot = (candidate: PoolCandidate) => {
      const slots = slotsOf()(candidate);
      return slots !== null && (inFlight.get(candidate) ?? 0) < slots;
    };
    const preferMuchFaster = (piece: PoolCandidate[]): PoolCandidate[] => {
      if (!throughput.decision) {
        return piece;
      }
      const result = applySlowerPlacement(piece, {
        estimatedTokens: throughput.decision.estimatedTokens,
        measuredOf: (candidate) => throughput.measured.get(candidate),
        inFlightOf: (candidate) => inFlight.get(candidate) ?? 0,
        hasFreeSlot,
        holdsFront: (candidate) => candidate === affinity.held || (pin !== null && pinMatches(candidate, pin)),
        mayGoAhead: staysInPlace,
        withheld: (candidate) =>
          !quarantineEmpty &&
          this.outputQuarantine.isWithheld({ nodeKey: candidate.peerId ?? LOCAL_CANDIDATE_KEY, backend: candidate.backend, model }),
        ...thresholds,
      });
      slowerDemoted.push(...result.demoted);
      return result.ordered;
    };
    // The cap is the outermost split and the ceiling the next, because both are operator statements
    // and a node over its cap reloads or truncates where a node over its ceiling is merely slow. The
    // other three are inferences and act within those: slots outside throughput, because a full
    // engine queues the request whole where a slow one merely reads it slowly, and contention inside
    // throughput, because a slow node misses its whole budget where a contended one may be waiting
    // out a turn that is nearly done. With nothing demoted, deferred or preferred for speed and no
    // over-cap or over-ceiling tail this is `applyPin(ordered, pin)` exactly, which keeps an
    // unmeasured fleet on the order it had before any of the five existed. The ceiling's own
    // "everything over means nothing moves" rule was judged on the whole list, so `overCeiling` is
    // already empty in that case.
    const candidates = [cap.preferred, cap.overCap].flatMap((capGroup) =>
      splitDemoted(capGroup, overCeiling).flatMap((group) =>
        splitDemoted(group, slots.demoted).flatMap((slotPart) =>
          splitByThroughput(slotPart, throughput, scoreOf).flatMap((part) =>
            giveWay(part).flatMap((piece) => preferMuchFaster(applyPin(piece, pin))),
          ),
        ),
      ),
    );
    if (throughput.decision && slowerDemoted.length > 0) {
      const moves = slowerDemoted
        .map(
          (entry) =>
            `${entry.node} (~${entry.predictedMs}ms, ${entry.inFlight} in flight) behind ${entry.fasterNode} (~${entry.fasterMs}ms, ${entry.fasterInFlight} in flight)`,
        )
        .join('; ');
      this.logger.debug(
        `[PoolProxy] ~${throughput.decision.estimatedTokens}-token prompt for "${model}" put ${moves}: predicted at least ${thresholds.ratio}x and ${thresholds.floorMs}ms faster`,
      );
    }
    return {
      candidates,
      pin,
      promptCeiling: ceiling.decision,
      contextCap: cap.decision,
      slots: slots.decision,
      throughput: throughput.decision && slowerDemoted.length > 0 ? { ...throughput.decision, slowerDemoted } : throughput.decision,
      contention: contended ? this.describeContention(model, contended, gaveWayTo, heldByAffinity ? held : null) : null,
      // Judged on the FINAL list: `hit` is a promise that the request goes to the remembered engine
      // first, and a ceiling, a demotion or a pin applied after affinity can each have put another
      // node there. The routing log's other sections say which one did.
      affinity: {
        decision: affinity.describe(candidates[0]),
        key: affinity.key,
      },
      peers,
      localProbes,
    };
  }

  /**
   * {@link applyPrefixAffinity} against the store, plus what to tell the routing log about it.
   *
   * Everything short-circuits on the knob: at 0 the key is never derived, the store is never read,
   * and the ranked list comes back untouched — which is what makes the default byte-identical to the
   * build before affinity, and the whole reason the knob doubles as the switch. One debug line for a
   * request affinity changed or stood aside on, never at info, for the same reason the ceiling logs
   * that way: the routing log is where decisions are read, and an agent turns all day.
   *
   * `held` is the candidate affinity qualified, which local-engine contention then leaves in place
   * while its prefix can still be warm; `null` whenever affinity did not put the remembered engine
   * first itself.
   */
  private applyRememberedPlacement(
    ranked: RankedCandidate[],
    prefixKey: (() => PrefixKey | null) | undefined,
  ): {
    ordered: RankedCandidate[];
    key: PrefixKey | null;
    held: PoolCandidate | null;
    describe: (first: PoolCandidate | undefined) => PoolRoutingAffinity | null;
  } {
    const nothing = { ordered: ranked, key: null, held: null, describe: () => null };
    const maxInFlight = this.prefixAffinityMaxInFlight();
    const affinityMargin = this.prefixAffinityMargin();
    // `!(> 0)` rather than `<= 0`: a settings object from before this knob existed reads `undefined`
    // here, and that must read as off, never as "no limit".
    if (!(maxInFlight > 0) || !prefixKey) {
      return nothing;
    }
    const key = prefixKey();
    if (!key) {
      return nothing;
    }
    const remembered = this.prefixAffinity.get(key.key);
    const { ordered, sticky, qualified, leastLoadedInFlight } = applyPrefixAffinity(ranked, remembered, maxInFlight, affinityMargin);
    return {
      ordered,
      key,
      held: sticky && qualified ? sticky.candidate : null,
      describe: (first) => {
        // `hit` says where the session landed; `qualified` says whether affinity is why. A remembered
        // engine the ranker put first on its own is a `hit` affinity had no part in, and the row
        // must be able to say so — see `PoolRoutingAffinity.qualified`.
        const outcome = sticky ? (first === sticky.candidate ? 'hit' : 'skipped') : 'miss';
        if (sticky && outcome === 'skipped') {
          this.logger.debug(
            qualified
              ? `[PoolProxy] ${sticky.candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY} holds this prompt's prefix and qualified, but a ceiling, a demotion or a pin placed another node first`
              : `[PoolProxy] ${sticky.candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY} holds this prompt's prefix but has ${sticky.inFlight} in flight (limit ${maxInFlight}, margin ${affinityMargin}, least loaded ${leastLoadedInFlight ?? '-'}); ranking as usual`,
          );
        }
        return {
          key: key.source,
          outcome,
          qualified,
          remembered: remembered?.node ?? null,
          inFlight: sticky?.inFlight ?? null,
          leastLoadedInFlight,
          maxInFlight,
          affinityMargin,
        };
      },
    };
  }

  /**
   * Each candidate's live prefill evidence — what this node timed, plus for a peer what it advertised
   * about itself — then {@link applyThroughputPlacement} against the budget the forward will carry.
   *
   * Both sources feed one prediction that takes the slowest applicable point, so a peer cannot talk its
   * way out of a deadline this node watched it miss. The body is measured only when some candidate has
   * evidence, and one debug line is written per request that demoted or deferred something, as for
   * the ceiling.
   *
   * An unmeasured peer is judged on the prior its advertised `hardwareTier` gives it (see
   * {@link unmeasuredPriorOf}). Three kinds of candidate keep their place unmeasured whatever the prompt:
   *
   * - **This node's own engine.** Its evidence is forgotten on every Hub restart while the engine's
   *   prefix cache is not, so deferring it then would trade a warm prefix for a cold prefill on a peer;
   *   and `poolLocalAffinity` is the operator's statement about it.
   * - **The engine prefix affinity holds.** The session's prefix is warm there, and the measured node
   *   it would give way to reads the whole prompt cold.
   * - **A pinned peer.** The pin is the operator's statement; unmeasured is a prior, not a measurement
   *   that could overrule it the way a predicted miss does.
   */
  private applyMeasuredThroughput(
    model: string,
    ordered: PoolCandidate[],
    peers: HubPoolPeer[],
    measurePromptBytes: () => number,
    streaming: boolean,
    placement: Pick<UnmeasuredPlacement, 'groupOf' | 'scoreOf' | 'staysInPlace'> & {
      pinned: (candidate: PoolCandidate) => boolean;
      held: PoolCandidate | null;
    },
  ): ThroughputPlacement {
    if (!throughputPlacementEnabled()) {
      return { demoted: NOTHING_DEMOTED, deferred: NOTHING_DEFERRED, measured: NOTHING_MEASURED, decision: null };
    }
    const now = Date.now();
    const advertised = new Map(
      peers.map((peer) => [
        peer.id,
        readAdvertisedThroughput(
          (peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.throughput,
          // Our clock, like snapshot freshness: the advert's ages are relative to when the peer answered.
          peer.lastSeenAt ? now - parseDbTimestampMs(peer.lastSeenAt) : Number.NaN,
        ),
      ]),
    );
    const pointsOf = (candidate: PoolCandidate): SourcedPrefillPoint[] => {
      const observed = this.throughput.prefillPoints({ nodeKey: candidate.peerId ?? LOCAL_CANDIDATE_KEY, backend: candidate.backend, model }, now);
      if (candidate.peerId === null) {
        return observed;
      }
      const told = (advertised.get(candidate.peerId) ?? [])
        .filter((estimate) => estimate.backend === candidate.backend && sameModelId(estimate.model, model))
        .flatMap((estimate) => prefillPointsOf(estimate, 'advertised', now));
      return [...observed, ...told];
    };
    const points = new Map(ordered.map((candidate) => [candidate, pointsOf(candidate)]));
    if (![...points.values()].some((list) => list.length > 0)) {
      return { demoted: NOTHING_DEMOTED, deferred: NOTHING_DEFERRED, measured: NOTHING_MEASURED, decision: null };
    }
    const tiers = new Map(peers.map((peer) => [peer.id, (peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.hardwareTier]));
    const priorOf = (candidate: PoolCandidate): UnmeasuredPrior | null =>
      candidate.peerId === null || candidate === placement.held || placement.pinned(candidate)
        ? null
        : unmeasuredPriorOf(tiers.get(candidate.peerId));
    const bytes = measurePromptBytes();
    const estimatedTokens = estimatePromptTokens(bytes);
    const result = applyThroughputPlacement(
      ordered,
      (candidate) => predictPrefill(points.get(candidate) ?? [], estimatedTokens, now),
      estimatedTokens,
      forwardBudgetMs(streaming, bytes),
      { priorOf, groupOf: placement.groupOf, scoreOf: placement.scoreOf, staysInPlace: placement.staysInPlace },
    );
    const decision = result.decision;
    if (decision && result.demoted.size > 0) {
      const nodes = decision.estimates
        .filter((estimate) => estimate.slow)
        .map(
          (estimate) =>
            `${estimate.node} (~${estimate.tokensPerSec} tok/s at ~${estimate.fromPromptTokens} tokens${estimate.extrapolated ? ', read forward' : ''} → ~${estimate.predictedMs}ms)`,
        )
        .join(', ');
      this.logger.debug(
        `[PoolProxy] ~${estimatedTokens}-token prompt for "${model}" put ${nodes} behind every candidate expected to meet its ${decision.budgetMs}ms budget`,
      );
    }
    if (decision && decision.unmeasured.length > 0) {
      const nodes = decision.unmeasured
        .map((entry) => `${entry.node} (${entry.prior === 'cpu-only' ? 'unmeasured, no GPU advertised' : 'unmeasured'})`)
        .join(', ');
      this.logger.debug(
        `[PoolProxy] ~${estimatedTokens}-token prompt for "${model}" put ${nodes} behind the candidates as busy as them measured to meet its ${decision.budgetMs}ms budget`,
      );
    }
    return result;
  }

  /**
   * Each candidate's context cap — this node's `inferenceMaxNumCtx` for a local candidate, the
   * `maxNumCtx` a peer advertised for a peer — then {@link applyContextCap} against the window the
   * request asks for.
   *
   * That window is the body's `options.num_ctx` when it carries one (the native Ollama dialect, which
   * is what both agents on the fleet speak), and otherwise the prompt estimate: a request without
   * `num_ctx` — every OpenAI-compatible `/v1` call — runs at the serving engine's own default
   * window, which is exactly what the node's cap records, and a prompt over that window is truncated
   * there. So the estimate is the smallest window the request can be served in, and a capped node
   * below it is moved back for the same reason a capped node below an explicit `num_ctx` is.
   *
   * Caps come from the same places everything else in ranking does: the in-memory settings object
   * and the capability snapshots `usablePeers` already loaded, so this adds no query. The body is
   * measured only when some candidate has a cap, and one debug line is written per request the cap
   * actually changed, never at info, for the ceiling's reason.
   */
  private applyContextCaps(
    model: string,
    ordered: PoolCandidate[],
    peers: HubPoolPeer[],
    measurePromptBytes: () => number,
    numCtxOf: (() => number | null) | undefined,
  ): ReturnType<typeof applyContextCap> {
    const capOf = this.contextCapOf(peers);
    if (!ordered.some((candidate) => capOf(candidate) !== null)) {
      return { preferred: ordered, overCap: [], decision: null };
    }
    const numCtx = numCtxOf?.() ?? null;
    const request =
      numCtx === null ? { numCtx: estimatePromptTokens(measurePromptBytes()), source: 'estimated' as const } : { numCtx, source: 'request' as const };
    const result = applyContextCap(ordered, capOf, request);
    const decision = result.decision;
    if (decision && decision.excluded.length > 0) {
      const nodes = decision.excluded.map((entry) => `${entry.node} (cap ${entry.maxNumCtx})`).join(', ');
      const window = decision.source === 'request' ? `num_ctx ${decision.numCtx}` : `~${decision.numCtx}-token prompt with no num_ctx`;
      this.logger.debug(
        decision.overridden
          ? `[PoolProxy] ${window} for "${model}" is over every candidate's context cap — ${nodes} — so placing it anyway`
          : `[PoolProxy] ${window} for "${model}" put ${nodes} behind every candidate whose cap can take it`,
      );
    }
    return result;
  }

  /**
   * Each candidate's context cap, from this node's `inferenceMaxNumCtx` or a peer's advertised
   * `maxNumCtx`, `null` where none is stated. One reader for placement and for the request-error
   * walk, so "the same window" means the same thing to both.
   */
  private contextCapOf(peers: HubPoolPeer[]): (candidate: PoolCandidate) => number | null {
    const peerCaps = new Map<string, number | null>(
      peers.map((peer) => [peer.id, clampContextCap((peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.maxNumCtx)]),
    );
    return (candidate) => (candidate.peerId === null ? this.localEngineWindow(candidate.backend) : (peerCaps.get(candidate.peerId) ?? null));
  }

  /**
   * The window each candidate runs this request at, `null` where it is not known — what the request-
   * error walk compares to decide whether a second "exceeds the context" answer confirms the first,
   * and whether a candidate still ahead might fit the prompt.
   *
   * Stricter than {@link contextCapOf}, because here a wrong window ends the walk rather than
   * reorders it. A request that sets `options.num_ctx` on Ollama's native routes is loaded at that
   * window by every Ollama engine, whatever their caps say. Otherwise an Ollama engine runs its
   * node's cap, the operator's statement of `OLLAMA_CONTEXT_LENGTH`; any other engine runs the window
   * it states itself, which only this node's own engines do. An unknown window matches nothing and
   * is never "no larger", so on a fleet that states none the walk goes on as it did before.
   */
  private contextWindowOf(path: string, body: unknown, peers: HubPoolPeer[]): (candidate: PoolCandidate) => number | null {
    const numCtx = requestedWindow(path, body);
    const capOf = this.contextCapOf(peers);
    return (candidate) => {
      if (candidate.backend === 'ollama') {
        return numCtx ?? capOf(candidate);
      }
      return candidate.peerId === null ? clampContextCap(this.localEngineStatement(candidate.backend)?.contextLength) : null;
    };
  }

  /**
   * The slot count each candidate's node states for it — this node's own `inferenceOllamaSlots` (or a
   * local engine's own count) for a local candidate, the figure a peer advertised for a peer — or
   * `null` for a node that states none, or an engine not in {@link SLOT_STATED_BACKENDS}. From the
   * in-memory settings object and the snapshots `usablePeers` already loaded, so it costs no query.
   */
  private advertisedSlotsOf(peers: HubPoolPeer[]): (candidate: PoolCandidate) => number | null {
    const localSlots = clampOllamaSlots(this.configuration.getInferencePreferences()?.ollamaSlots);
    const peerSlots = new Map<string, number | null>(
      peers.map((peer) => [peer.id, clampOllamaSlots((peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.ollamaSlots)]),
    );
    return (candidate) => {
      if (!SLOT_STATED_BACKENDS.has(candidate.backend)) {
        return null;
      }
      // Same precedence as the cap: a local engine's own slot count first, the node's statement after.
      return candidate.peerId === null
        ? (clampOllamaSlots(this.localEngineStatement(candidate.backend)?.slots) ?? localSlots)
        : (peerSlots.get(candidate.peerId) ?? null);
    };
  }

  /**
   * Each Ollama candidate's queue depth against the slot count its node stated — this node's own
   * `inferenceOllamaSlots` for a local candidate, the figure a peer advertised for a peer — then
   * {@link applySlotPlacement}.
   *
   * Everything short-circuits on the knob: at 0 no slot count is read and nothing is demoted, which
   * is what makes the default byte-identical to the build before slots. The queue depth is the
   * ranked entry's own `inFlight` — the number the sort just used, so the decision and the order it
   * shaped agree on what the queue was. Slot counts come from the same places everything else in
   * ranking does (the in-memory settings object and the snapshots `usablePeers` already loaded), so
   * this adds no query. One debug line per request that demoted something, as for the ceiling.
   */
  private applyAdvertisedSlots(model: string, ranked: RankedCandidate[], peers: HubPoolPeer[]): ReturnType<typeof applySlotPlacement> {
    // `!(> 0)` rather than `<= 0`, as for affinity: a settings object from before this knob existed
    // reads `undefined` here, and that must read as off.
    if (!(this.slotAwareness() > 0)) {
      return { demoted: NOTHING_DEMOTED, decision: null };
    }
    const slotsOf = this.advertisedSlotsOf(peers);
    const inFlightOf = new Map(ranked.map((entry) => [entry.candidate, entry.inFlight]));
    const result = applySlotPlacement(
      ranked.map((entry) => entry.candidate),
      (candidate) => {
        const slots = slotsOf(candidate);
        const inFlight = inFlightOf.get(candidate);
        return slots === null || inFlight === undefined ? null : { inFlight, slots };
      },
    );
    const decision = result.decision;
    if (decision && decision.demoted.length > 0) {
      const nodes = decision.demoted.map((entry) => `${entry.node} (${entry.inFlight} in flight, ${entry.slots} slots)`).join(', ');
      this.logger.debug(
        decision.overridden
          ? `[PoolProxy] every candidate for "${model}" has its slots full — ${nodes} — so placing it anyway`
          : `[PoolProxy] "${model}" put ${nodes} behind every candidate with a free slot`,
      );
    }
    return result;
  }

  /**
   * Each local candidate's engine judged for {@link applyLocalContention}: the generations this node
   * has in flight on it that the request cannot join. `null` when nothing was judged — the kill
   * switch is off, or no peer could go ahead of this node — and an empty `engines` when nothing here
   * was contended.
   *
   * Read from this node's own records — what it placed on its engines and what peers forwarded to
   * them — so it asks the engine nothing on the request path. Another model's generation is always
   * contention: Ollama either evicts behind that turn or loads beside it and shares the engine, and
   * which of the two it would do changes the cost, not the call. This model's generation is
   * contention only on an engine that reloads per window, at a window other than the one this request
   * runs at — a reload has to wait for it. The window is resolved as the engine runs it: a request's
   * own `num_ctx`, else the default this node states for the engine (see {@link localEngineWindow}).
   * Two requests that name no window run at the same default whatever it is, but with no default
   * stated, one that names none cannot be shown to match one that names a number, and is judged not
   * to: the fleet's 35b relaunched six times in three minutes on exactly that mismatch.
   */
  private judgeLocalContention(
    model: string,
    ordered: PoolCandidate[],
    numCtxOf: (() => number | null) | undefined,
  ): { numCtx: number | null; engines: Map<PoolCandidate, LocalEngineContention> } | null {
    if (!placementSwitchOn(HUB_POOL_CONTENTION_PLACEMENT_ENV_VAR) || !ordered.some((candidate) => candidate.peerId !== null)) {
      return null;
    }
    const numCtx = numCtxOf?.() ?? null;
    const engines = new Map<PoolCandidate, LocalEngineContention>();
    for (const candidate of ordered) {
      const running = candidate.peerId === null ? this.loadService.localGenerationsOn(candidate.backend) : [];
      if (running.length === 0) {
        continue;
      }
      const judgesWindow = WINDOW_RELOADING_BACKENDS.has(candidate.backend);
      const engineDefault = judgesWindow ? this.localEngineWindow(candidate.backend) : null;
      const runsAt = numCtx ?? engineDefault;
      const busyWith: LocalEngineContention['busyWith'] = [];
      for (const generation of running) {
        const window = generation.numCtx ?? engineDefault;
        const joinable = sameModelId(generation.model, model) && (!judgesWindow || window === runsAt);
        // One entry per model and window as the engine runs them: a `/v1` request and a native one
        // naming the stated default are the same load.
        if (!joinable && !busyWith.some((entry) => entry.model === generation.model && entry.numCtx === window)) {
          busyWith.push({ model: generation.model, numCtx: window });
        }
      }
      if (busyWith.length > 0) {
        engines.set(candidate, { busyWith, runsAt });
      }
    }
    return { numCtx, engines };
  }

  /**
   * Whether a session's prompt prefix can still be warm on `held`, the contended local engine prefix
   * affinity qualified, so that contention may leave it where affinity put it. `false` sends it
   * through contention like any other engine, which is the build before the exemption.
   *
   * Affinity remembers where a session was placed, not whether the engine kept what it read, and a
   * contended engine is exactly one that may not have. Two things discard the prefix, and each also
   * makes the turn wait, which is what contention placement exists to prevent — beta-max, 2026-09-26,
   * had a 35b turn wait out its whole 327 s budget behind both in turn:
   *
   * - This model generating there at another window (`found.busyWith`, this node's own records): Ollama
   *   reloaded the runner for it, and must wait for it and reload again for this one.
   * - This model no longer resident there: the turn waits out the other model's generation and an
   *   eviction, or a load beside it, and then prefills cold anyway.
   *
   * Residency is asked of the engine only here, after the first test passes, so a node with affinity
   * off, or whose held engine is not contended, never asks. A residency it cannot read does not show
   * the prefix warm: the engine says it cannot tell, the read throws, or it has not answered within
   * {@link PLACEMENT_PROBE_BUDGET_MS} — the budget the local health read holds an `/api/ps` behind a
   * DROP rule to, rather than its 5 s transport timeout. An engine with no residency concept serves
   * what it was started with, so the inventory that made it a candidate is its residency.
   *
   * One debug line when it refuses, never at info, for the ceiling's reason.
   */
  private async prefixCanStillBeWarm(model: string, held: PoolCandidate, found: LocalEngineContention): Promise<boolean> {
    const reload = found.busyWith.find((generation) => sameModelId(generation.model, model));
    const refusal = reload
      ? `${reload.model} is generating there at ${describeWindow(reload.numCtx)}, not this turn's ${describeWindow(found.runsAt)}: the load that runs it replaced the one the prefix was read on, and this turn waits for it and reloads`
      : await this.localResidencyRefusal(model, held.backend);
    if (refusal === null) {
      return true;
    }
    this.logger.debug(
      `[PoolProxy] "${model}" is not holding ${held.nodeFqdn ?? LOCAL_CANDIDATE_KEY} ${held.backend} over contention for its session prefix: ${refusal}`,
    );
    return false;
  }

  /** Why this node's `backend` cannot be shown to hold `model` resident, or `null` when it can — see {@link prefixCanStillBeWarm}. */
  private async localResidencyRefusal(model: string, backend: InferenceBackendType): Promise<string | null> {
    const engine = this.backends.tryGet(backend);
    if (typeof engine?.listResident !== 'function') {
      return null;
    }
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<typeof RESIDENCY_BUDGET_ELAPSED>((resolve) => {
      budgetTimer = setTimeout(() => resolve(RESIDENCY_BUDGET_ELAPSED), PLACEMENT_PROBE_BUDGET_MS);
    });
    try {
      const residency = await Promise.race([engine.listResident(), budget]);
      if (residency === RESIDENCY_BUDGET_ELAPSED) {
        return `its residency did not answer within ${PLACEMENT_PROBE_BUDGET_MS} ms`;
      }
      if (!residency?.models) {
        return `it cannot say what is resident (${residency?.source ?? 'no answer'}${residency?.error ? `: ${residency.error}` : ''})`;
      }
      return residency.models.some((resident) => sameModelId(resident.id, model)) ? null : `${model} is no longer resident there`;
    } catch (error) {
      return `its residency could not be read: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  /**
   * The routing log's account of {@link judgeLocalContention} and {@link applyLocalContention}, and
   * one debug line when an engine gave way — never at info, for the ceiling's reason. `null` when
   * no engine here was contended. `heldByAffinity` is the engine that would have given way but for
   * prefix affinity, which the row names as `overriddenBy: 'affinity'`.
   */
  private describeContention(
    model: string,
    contended: { numCtx: number | null; engines: Map<PoolCandidate, LocalEngineContention> },
    gaveWayTo: Map<PoolCandidate, PoolCandidate[]>,
    heldByAffinity: PoolCandidate | null,
  ): PoolRoutingContention | null {
    if (contended.engines.size === 0) {
      return null;
    }
    const nodeOf = (candidate: PoolCandidate) => candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY;
    const demoted: PoolRoutingContentionDemotion[] = [...contended.engines].map(([candidate, found]) => ({
      node: nodeOf(candidate),
      backend: candidate.backend,
      busyWith: found.busyWith,
      runsAt: found.runsAt,
      behind: (gaveWayTo.get(candidate) ?? []).map(nodeOf),
      overriddenBy: candidate === heldByAffinity ? 'affinity' : null,
    }));
    const held = demoted.find((entry) => entry.overriddenBy === 'affinity');
    if (held) {
      this.logger.debug(
        `[PoolProxy] "${model}" kept ${held.node} ${held.backend} first though it is busy with ${held.busyWith.map((generation) => generation.model).join(', ')}: it holds this session's prompt prefix`,
      );
    }
    const moved = demoted.filter((entry) => entry.behind.length > 0);
    if (moved.length > 0) {
      const engines = moved
        .map((entry) => {
          const busy = entry.busyWith.map((generation) => `${generation.model} at ${describeWindow(generation.numCtx)}`).join(', ');
          return `${entry.node} ${entry.backend} (busy with ${busy}; this one at ${describeWindow(entry.runsAt)}) behind ${entry.behind.join(', ')}`;
        })
        .join('; ');
      this.logger.debug(`[PoolProxy] "${model}" moved ${engines}, which were no busier once its local head start was set aside`);
    }
    return { numCtx: contended.numCtx, demoted, overridden: false };
  }

  /**
   * The window a local engine runs a request at when the request names none, as this node states it:
   * the engine's own statement (llama-server's `/props`), else the node's context cap, which its
   * operator sets to `OLLAMA_CONTEXT_LENGTH` because Ollama's API does not expose it. `null` when
   * neither is stated. The same figure a context cap holds a request to — see {@link applyContextCaps}.
   */
  private localEngineWindow(backend: InferenceBackendType): number | null {
    // Believed over the node-wide statement: the statement describes Ollama, and a window the engine
    // itself runs is exactly what the cap exists to keep a request inside.
    return (
      clampContextCap(this.localEngineStatement(backend)?.contextLength) ?? clampContextCap(this.configuration.getInferencePreferences()?.maxNumCtx)
    );
  }

  /**
   * What a local engine says about its own slots and per-slot context, from its last health probe
   * (`InferenceBackend.engineCapabilities`) — never a request of its own, since this runs while
   * ranking every request. `null` for every engine that does not state them, which is all but
   * llama-server today.
   */
  private localEngineStatement(backend: InferenceBackendType): EngineCapabilities | null {
    return this.backends.tryGet(backend)?.engineCapabilities?.() ?? null;
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

  async proxyRequest(params: {
    path: string;
    method: string;
    body: unknown;
    model: string;
    res: Response;
    /** The app's `X-Hub-Pool-Session` header as Express read it, if it sent one — see `POOL_SESSION_HEADER`. */
    sessionHeader?: string | string[];
  }): Promise<void> {
    // One close watch for the whole request, taken off the response once it has settled — see `watchClient`.
    const watch = watchClient(params.res);
    try {
      await this.routeRequest(params, watch);
    } finally {
      watch.dispose();
    }
  }

  private async routeRequest(params: Parameters<PoolProxyService['proxyRequest']>[0], watch: ResponseCloseWatch): Promise<void> {
    const { path, method, res } = params;
    const startedAt = Date.now();
    const clientClosed = watch.clientClosed;
    const model = await this.resolveModelAlias(params.model);
    if (!model) {
      const failed = this.routingLog.record({
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
        contextCap: null,
        slots: null,
        throughput: null,
        contention: null,
        affinity: null,
        outcome: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        usage: null,
        reason: `nothing in the pool can stand in for "${AUTO_MODEL}"`,
      });
      res.setHeader(POOL_REQUEST_ID_HEADER, failed.id);
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
    const streaming = isStreamingRequest(body, path);
    // Throughput is judged, and measured, on exactly the routes the ceiling is: a body that is one
    // context the engine reads before its first token.
    const judged = PROMPT_CEILING_PATHS.has(path);
    // Serialised once for ranking and every attempt, rather than once per forward.
    const payload = memoize(() => forwardedPayload(method, body));
    // Keyed on the resolved model, never the alias: `auto` on two Hubs can mean two models, and the
    // cache a session warms is the resolved one's.
    const prefixKey = memoize(() => derivePrefixKey(model, body, params.sessionHeader));
    const {
      candidates: ranked,
      pin,
      promptCeiling,
      contextCap,
      slots,
      throughput,
      contention,
      affinity,
      peers,
      localProbes,
    } = await this.rankCandidates(
      model,
      judged ? { bytes: () => payload()?.length ?? 0, streaming, prefixKey, numCtx: () => requestedWindow(path, body) } : undefined,
    );
    // After every placement step and the pin, so nothing puts an engine that has been answering with
    // garbage back in front — the local head start included.
    const candidates = this.demoteWithheldEngines(model, ranked, affinity.decision);
    // Nodes a candidate rejected before one answered. Non-empty in the finished record is exactly
    // what makes it a failover, so the whole chain is one entry rather than one per attempt.
    const failedOverFrom: string[] = [];
    // Why each of them was passed over, in the same order — see `PoolRoutingRecord.attempts`.
    const attempts: PoolRoutingAttempt[] = [];
    const passOver = (candidate: PoolCandidate, node: string, status: number | null, reason: string) => {
      failedOverFrom.push(node);
      attempts.push({ node, backend: candidate.backend, status, reason });
    };
    // The completion dialect this path answers in, whose output is judged; `null` for every other route.
    const dialect = outputDialectOf(path);

    if (candidates.length === 0) {
      const failed = this.routingLog.record({
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
        contextCap,
        slots,
        throughput,
        contention,
        affinity: affinity.decision,
        outcome: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        usage: null,
        reason: 'no candidate',
        ...describeRequestShape(method, body, path),
      });
      res.setHeader(POOL_REQUEST_ID_HEADER, failed.id);
      // `localBackends` is the container's-eye view of every local engine: the operator reading
      // this on a node that plainly runs the model needs the probed URL and the error, not a
      // second look at the inventory.
      res.status(502).json({ error: describeNoCandidates(model, pin, localProbes), localBackends: localProbes });
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
      attempts,
      pin: describePinForLog(pin),
      promptCeiling,
      contextCap,
      slots,
      ...describeRequestShape(method, body, path),
      throughput,
      contention,
      affinity: affinity.decision,
    });
    // The decision stated on the response, like the serving node: set on the 502 too, since a turn
    // that failed everywhere is one an operator will want to know was or was not following its prefix.
    const affinityHeader: Record<string, string> = affinity.decision ? { [POOL_AFFINITY_HEADER]: affinity.decision.outcome } : {};

    let lastError: unknown;
    let committed = false;
    // An engine's verdict on the request that its node alone could not vouch for, carried forward
    // until the next candidate to answer agrees with it or serves the request.
    let unconfirmed: UnconfirmedRequestError<PoolCandidate> | null = null;
    // Built only once an engine says the prompt was too long, which is the one verdict that needs it.
    const contextWindows = memoize(() => this.contextWindowOf(path, body, peers));
    // The candidates in the order they are tried: the ranked order, then, once more at the end, each
    // local engine the Hub refused to load the model on while another candidate could still take the
    // request (see `arbitrateLocalLoad`). On such a row `attempt` can run one past `candidates`.
    const walk = [...candidates];
    // Each local engine passed over for a refused load, with the Hub's reason. Reaching it again at
    // the end means every other candidate failed; it is then sent the request without arbitration.
    const refusedLoads = new Map<PoolCandidate, LocalLoadRefusal>();
    for (let index = 0; index < walk.length; index += 1) {
      const candidate = walk[index] as PoolCandidate;
      const key = candidate.peerId ?? LOCAL_CANDIDATE_KEY;
      const nodeLabel = candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY;
      if (index > 0) {
        this.routingLog.update(row, { node: nodeLabel, peerId: candidate.peerId, backend: candidate.backend, attempt: index + 1 });
      }
      // Reaching an over-ceiling node means every node under a ceiling already failed. Recorded as an
      // override, so the log reads "placed over its ceiling" instead of claiming the node was skipped.
      if (row.promptCeiling && !row.promptCeiling.overridden && row.promptCeiling.excluded.some((entry) => entry.node === nodeLabel)) {
        row.promptCeiling.overridden = true;
        this.logger.debug(
          `[PoolProxy] every candidate under its prompt ceiling failed for "${model}"; trying ${nodeLabel}, which is over its ceiling`,
        );
      }
      // Same for the cap: reaching a node capped below the window means every node that could take
      // it already failed, and the log should read "placed over its cap" rather than "skipped".
      if (row.contextCap && !row.contextCap.overridden && row.contextCap.excluded.some((entry) => entry.node === nodeLabel)) {
        row.contextCap.overridden = true;
        this.logger.debug(
          `[PoolProxy] every candidate whose context cap can take ${row.contextCap.numCtx} failed for "${model}"; trying ${nodeLabel}, which is capped below it`,
        );
      }
      // Reaching a full node means nothing with a free slot is ahead of it any more: every such node
      // failed, or a prompt ceiling put them all behind it. Recorded as an override for the same
      // reason as the ceiling's: the log must not claim the node was skipped.
      const placedSlots = row.slots;
      if (
        placedSlots &&
        !placedSlots.overridden &&
        placedSlots.demoted.some((entry) => entry.node === nodeLabel && entry.backend === candidate.backend)
      ) {
        placedSlots.overridden = true;
        this.logger.debug(`[PoolProxy] placing "${model}" on ${nodeLabel}, whose slots are full, because nothing with a free slot is ahead of it`);
      }
      const placedThroughput = row.throughput;
      if (
        placedThroughput &&
        !placedThroughput.overridden &&
        placedThroughput.estimates.some((estimate) => estimate.slow && estimate.node === nodeLabel && estimate.backend === candidate.backend)
      ) {
        placedThroughput.overridden = true;
        this.logger.debug(
          `[PoolProxy] placing "${model}" on ${nodeLabel}, predicted to miss its ${placedThroughput.budgetMs}ms budget, because nothing ahead of it answered`,
        );
      }
      // Reaching a contended engine means nothing it gave way to answered, or every candidate behind
      // it was busier. Recorded as an override for the same reason as the slots'; `behind` says which.
      const placedContention = row.contention;
      const placedEngine = placedContention?.demoted.find((entry) => entry.node === nodeLabel && entry.backend === candidate.backend);
      if (placedContention && placedEngine && !placedContention.overridden) {
        placedContention.overridden = true;
        this.logger.debug(
          placedEngine.behind.length > 0
            ? `[PoolProxy] placing "${model}" on ${nodeLabel}, whose engine is busy with work this request cannot join, because nothing it gave way to answered`
            : placedEngine.overriddenBy === 'affinity'
              ? `[PoolProxy] placing "${model}" on ${nodeLabel}, whose engine is busy with work this request cannot join, because it holds this session's prompt prefix`
              : `[PoolProxy] placing "${model}" on ${nodeLabel}, whose engine is busy with work this request cannot join, because it gave way to nothing`,
        );
      }
      const target: ThroughputTarget = { nodeKey: key, backend: candidate.backend, model };
      // Judged before this request joins the count: a node with other work in flight is timed as a
      // queue, and a queue recorded as slow hardware would outlive the queue by hours.
      const measurable = judged && this.idleForMeasurement(candidate, peers);
      const attemptStartedAt = Date.now();
      // Named by model and window only on this node's own engine and only for a generation, which is
      // what the next request's contention judgement asks about.
      const generation: LocalGeneration | undefined =
        judged && candidate.peerId === null ? { backend: candidate.backend, model, numCtx: requestedWindow(path, body) } : undefined;
      // An embedding batch on this node's engine: not a turn, but its model is busy until it ends.
      const embedding: LocalModelWork | undefined =
        EMBEDDING_PATHS.has(path) && candidate.peerId === null ? { backend: candidate.backend, model } : undefined;
      this.loadService.acquire(key, generation, embedding);
      // At placement, before the engine answers, so a session's next call — an agent's parallel
      // tool calls arrive while the first is still prefilling — finds the engine already reading
      // the shared prefix. A failover overwrites it with the candidate that actually took the work.
      if (affinity.key) {
        this.prefixAffinity.remember(affinity.key.key, candidate);
      }
      try {
        if (candidate.peerId === null) {
          const earlier = refusedLoads.get(candidate);
          // A refusal kept from before the other candidates were tried is read again when it was for busy
          // models: they may have ended since, and `awaitBusyModels` only looks again when they change.
          let refusal = earlier?.idleWouldFree === false ? earlier : await this.arbitrateLocalLoad(candidate, path, body, model, clientClosed);
          if (refusal !== null && earlier === undefined && walk.slice(index + 1).some((other) => !refusedLoads.has(other))) {
            // Another candidate can take the request, so this engine is not asked to load a model the
            // Hub could not make room for: it would load it anyway and overcommit the card, or put part
            // of it in system memory. Tried again after the rest rather than dropped, so a request
            // every other candidate fails is still sent here, as it was before a refusal failed over.
            refusedLoads.set(candidate, refusal);
            passOver(candidate, nodeLabel, null, describeLocalLoadRefusal(refusal.reason));
            // At log, not warn: nothing failed, the Hub kept a model off a card that could not hold it.
            this.logger.log(
              `[PoolProxy] the Hub refused to load "${model}" on ${candidate.backend} here (${refusal.reason}); ` +
                `trying the ${walk.length - index - 1} candidate(s) after it first`,
            );
            walk.push(candidate);
            continue;
          }
          if (refusal?.idleWouldFree) {
            // Nothing else can take it, and what stands in the way is generations that will end: waited
            // for here, so the models running them are not marked to expire for this request, and the
            // Hub makes the room itself once they are idle.
            refusal = await this.awaitBusyModels(candidate, path, body, model, clientClosed, refusal);
          }
          if (refusal !== null) {
            // Nothing else can take it: sent to the engine, which loads the model on its own terms.
            // Recorded on the row, because a local answer after a refused load is the one that may
            // have overcommitted the card.
            this.routingLog.update(row, { localLoadRefused: refusal.reason });
            this.logger.warn(
              `[PoolProxy] the Hub refused to load "${model}" on ${candidate.backend} here (${refusal.reason}), and no other candidate is left ` +
                `to take the request; sending it to ${candidate.backend} anyway, which loads the model on its own terms`,
            );
          }
        }
        const upstream = await this.forward(candidate, path, method, body, model, payload(), row.id, clientClosed);
        const headersAt = Date.now();
        // Read before the serving record and the failover decision, because both turn on it: a 500
        // that proves the request is bad is neither the model failing nor a reason to try the next node.
        const verdict = await readRequestErrorVerdict(upstream);
        // Before the failover branch, so both outcomes teach the local engine the same thing: a
        // live request is the only place the pool ever learns whether a model actually serves.
        this.noteLocalServing(candidate, model, upstream.status, verdict);
        const untried = walk.slice(index + 1);
        // A peer's engine refusing the key the peer holds for it: another node may well serve the
        // request, so it is tried, but the pairing is fine and the peer keeps its inventory. On the
        // last candidate the engine's own answer goes back, as a local engine's 401 always has,
        // rather than a 502 that names no cause.
        const peerEngineRefusal =
          candidate.peerId !== null && PEER_PAIRING_STATUSES.has(upstream.status) && isRelayedEngineResponse(upstream.headers);
        // A verdict no second candidate has confirmed ends the walk anyway on the last candidate:
        // there is nobody left to overrule it, and the engine's sentence is worth more to the caller
        // than a 502 that names no cause and that its SDK will retry into the same refusal.
        const requestError: PoolRoutingRequestError | null = verdict
          ? (judgeRequestError(verdict, candidate, unconfirmed, {
              untried,
              engineOf: (other) => other.backend,
              windowOf: (other) => contextWindows()(other),
            }) ?? (untried.length === 0 ? lastCandidateRequestError(verdict) : null))
          : null;
        if (!requestError && this.shouldFailover(candidate, upstream.status) && !(peerEngineRefusal && untried.length === 0)) {
          if (verdict) {
            unconfirmed = { verdict, candidate, node: nodeLabel };
            this.logger.debug(
              `[PoolProxy] ${nodeLabel} rejected the request for "${model}" (${verdict.signature}), which another node may not; asking the next candidate`,
            );
          }
          lastError = new Error(`${candidate.nodeFqdn ?? 'local'} returned ${upstream.status}`);
          const reason = describeStatusReason(upstream.status, verdict?.signature);
          passOver(candidate, nodeLabel, upstream.status, reason);
          this.logFailover(model, candidate, nodeLabel, upstream.status, reason, untried.length);
          await this.noteRejectedCandidate(candidate, upstream.status, upstream.headers);
          continue;
        }
        if (peerEngineRefusal) {
          // The one case where the app gets this refusal, so the one case the operator most needs
          // told: the routing log reads it as a refused request, which a key mismatch on a peer's
          // engine is not.
          this.warnPeerEngineRefusal(candidate, upstream.status, 'relaying its answer to the caller: no candidate is left to try');
        }
        const relayedStatus = verdict && requestError ? relayedRequestErrorStatus(verdict, upstream.status) : upstream.status;
        if (requestError) {
          // Warn, like a candidate failing: the app is sending something no node will run, and this
          // line is the one place outside the routing log that says so. The label, never the
          // engine's message, which can quote the prompt.
          this.logger.warn(
            `[PoolProxy] ${nodeLabel} rejected the request for "${model}" itself (HTTP ${upstream.status}, ${requestError.signature}` +
              `${requestError.confirms ? `, as ${requestError.confirms} did` : ''}); returning it to the caller` +
              `${relayedStatus === upstream.status ? '' : ` as HTTP ${relayedStatus}`}` +
              (requestError.basis === 'last-candidate'
                ? `: no candidate is left to confirm or overrule it (${candidates.length} tried)`
                : ` instead of trying ${untried.length} more candidate(s)`),
          );
        }
        // Everything the walk did not fail over and is not an engine's verdict is relayed on its
        // status, as it always was; a 4xx among those is the request refused, and is recorded so.
        const refusal = requestError ?? passedThroughRequestError(upstream.status);
        // A non-streamed completion is read whole before anything is sent, which is what lets an
        // answer that was cut off or degenerate go no further than this Hub while another candidate
        // can still be asked. Reading it costs the caller nothing: the engine sends the body with its
        // headers, the whole completion at once. A stream cannot be held — its first frame is on the
        // wire before its last exists — so it is judged on the way past, below, and only recorded.
        // A stream is whatever the engine sent as one, not only what the request asked for: holding
        // one would send the caller nothing until the generation ended.
        const streamedAnswer = streaming || isStreamedContentType(upstream.headers.get('content-type'));
        let heldBody: WebReadableStream<Uint8Array> | undefined;
        let outputFault: PoolOutputFault | null = null;
        if (dialect && !streamedAnswer && !refusal && upstream.ok && upstream.body) {
          const held = await holdWholeBody(upstream.body as WebReadableStream<Uint8Array>, MAX_JUDGED_BODY_BYTES).catch((error: unknown) => {
            // Said as the upstream failing mid-body, like the relay says it, so the catch below
            // reads it as the engine's failure rather than a transport error before any answer.
            throw new RelayError('upstream', error);
          });
          heldBody = held.body;
          const judgedBody = held.text === null ? null : judgeWholeBody(dialect, held.text);
          if (judgedBody?.fault) {
            this.strikeOutput(target, judgedBody.fault, nodeLabel);
            if (untried.length > 0) {
              lastError = new Error(`${nodeLabel} answered with ${describeOutputFault(judgedBody.fault)}`);
              passOver(candidate, nodeLabel, upstream.status, judgedBody.fault);
              this.logFailover(model, candidate, nodeLabel, upstream.status, describeOutputFault(judgedBody.fault), untried.length);
              continue;
            }
            // The last candidate: its answer goes to the caller as the engine gave it, which is all
            // there is, and the row says the node failed rather than that it served. Nor should the
            // session follow its prefix back to this engine on its next turn.
            outputFault = judgedBody.fault;
            if (affinity.key) {
              this.prefixAffinity.forget(affinity.key.key);
            }
          } else if (judgedBody?.complete) {
            this.clearOutputStrikes(target, nodeLabel);
          }
        }
        const nodeFault: PoolRoutingRequestError | null = outputFault ? { signature: outputFault, basis: 'node', confirms: null } : null;
        // Settled here rather than after the stream: headers are the routing decision, and the
        // generation that follows can run for minutes (or never end, if the client hung up).
        this.routingLog.settle(row, {
          node: nodeLabel,
          peerId: candidate.peerId,
          backend: candidate.backend,
          attempt: index + 1,
          // `failed` for any refusal of the request: the node answered, but nothing was served. A
          // 4xx settled `served` was read as a success with a first byte of a few milliseconds.
          outcome: refusal || nodeFault ? 'failed' : 'served',
          status: upstream.status,
          durationMs: Date.now() - startedAt,
          requestError: refusal ?? nodeFault,
          reason: outputFault ?? (refusal ? describeStatusReason(upstream.status, refusal.signature) : null),
        });
        // Attribution rides on the commit, so it is on the wire before the first body byte on the
        // streamed path too — the headers are the point of no return, the body follows.
        this.commitResponse(
          upstream,
          res,
          {
            ...servedByHeaders(candidate, model, row.id),
            ...affinityHeader,
            ...(relayedStatus === upstream.status ? {} : { [POOL_UPSTREAM_STATUS_HEADER]: String(upstream.status) }),
          },
          relayedStatus,
        );
        committed = true;
        const meter = measurable && upstream.ok ? startResponseTiming() : null;
        // Only a 200 that was relayed as the engine's answer: a refusal is not output, and a held
        // body was judged above.
        const judge = dialect && streamedAnswer && upstream.ok && !refusal ? new OutputJudge(dialect, true) : null;
        let relayCut = false;
        try {
          await this.streamResponse(upstream, res, watch, {
            onUsage: (usage) => {
              this.routingLog.attachUsage(row, usage);
              if (meter) meter.timing.usage = usage;
            },
            observer: meter?.observer,
            judge,
            body: heldBody,
          });
        } catch (error) {
          relayCut = error instanceof RelayError && error.side === 'upstream';
          throw error;
        } finally {
          // An answer the row records as the node failing is no measure of the engine serving: an
          // engine that emits placeholder tokens quickly would otherwise read as a fast one, and
          // placement would keep favouring it once its withhold ran out.
          if (meter && !outputFault && !relayCut && !judge?.verdict()?.fault) {
            this.recordServedThroughput(target, streaming, payload()?.length ?? 0, attemptStartedAt, headersAt, meter.timing);
          }
          this.routingLog.update(row, { totalMs: Date.now() - startedAt });
        }
        if (judge && this.settleStreamVerdict(row, judge.verdict(), target, nodeLabel) && affinity.key) {
          // A session must not keep following its prefix back to an engine that answered it with garbage.
          this.prefixAffinity.forget(affinity.key.key);
        }
        return;
      } catch (error) {
        if (clientClosed.aborted) {
          // Not a candidate failure, and never a reason to try the next one: nobody is left to read
          // the answer, and placing the turn again would cost a second engine the same prefill.
          this.noteClientClosed(row, committed, index, startedAt, nodeLabel);
          return;
        }
        lastError = error;
        if (!committed && measurable && streaming) {
          this.recordMissedDeadline(target, payload()?.length ?? 0, attemptStartedAt, error);
        }
        if (committed) {
          if (error instanceof RelayError && error.side === 'downstream') {
            // The response to the caller failed under the relay — its socket, not the node. Nobody is
            // left to read the answer, and the node served what it was asked.
            this.logger.debug(`[PoolProxy] the response from ${nodeLabel} could not be written to the client: ${error.message}`);
            res.destroy();
            return;
          }
          this.logger.warn(`[PoolProxy] candidate ${candidate.nodeFqdn ?? 'local'} (${candidate.backend}) failed: ${describeAttemptError(error)}`);
          // Status and headers (and likely some generated tokens) are already on the wire. Another
          // candidate would restart the answer into a response the client is mid-way through
          // reading, so let the stream die instead and leave the client to retry.
          this.logger.warn('[PoolProxy] response already committed to the client; not failing over');
          // The row settled `served` at headers time, and the caller got a cut-off answer from this
          // node: the node failed it. Not a failover, which nothing was — through `update` so
          // `?since=` returns the change.
          this.routingLog.update(row, {
            outcome: 'failed',
            requestError: { signature: 'truncated-upstream', basis: 'node', confirms: null },
            reason: 'truncated-upstream',
          });
          // Struck like an answer that ended without its final frame, which is what the caller got:
          // an engine that keeps dying mid-generation must not keep drawing every retry, the local
          // head start included. Nor should the session follow its prefix back to it.
          if (dialect && error instanceof RelayError && error.side === 'upstream') {
            this.strikeOutput(target, 'truncated-upstream', nodeLabel);
            if (affinity.key) {
              this.prefixAffinity.forget(affinity.key.key);
            }
          }
          res.destroy();
          return;
        }
        if (dialect && error instanceof RelayError && error.side === 'upstream') {
          // A held body the engine stopped sending part-way: cut off exactly as a streamed answer that
          // dies after the commit is, only caught while the next candidate can still be asked.
          this.strikeOutput(target, 'truncated-upstream', nodeLabel);
        }
        const reason = describeAttemptError(error);
        passOver(candidate, nodeLabel, null, reason);
        this.logger.warn(
          `[PoolProxy] candidate ${candidate.nodeFqdn ?? 'local'} (${candidate.backend}) failed: ${reason}` +
            (index + 1 < walk.length ? `; failing over (${walk.length - index - 1} candidate(s) left)` : '; no candidate left'),
        );
      } finally {
        this.loadService.release(key, generation, embedding);
      }
    }

    this.routingLog.settle(row, {
      node: null,
      peerId: null,
      backend: null,
      attempt: walk.length,
      outcome: 'failed',
      status: null,
      durationMs: Date.now() - startedAt,
      // The last candidate's; `attempts` holds every one.
      reason: attempts[attempts.length - 1]?.reason ?? null,
    });
    this.logger.error(
      `[PoolProxy] all ${candidates.length} candidate(s) for model "${model}" failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    // Nothing holds this prefix now — the last engine to try it gave up — so the next call ranks fresh.
    if (affinity.key) {
      this.prefixAffinity.forget(affinity.key.key);
    }
    if (!res.headersSent) {
      res.setHeader(POOL_REQUEST_ID_HEADER, row.id);
      for (const [name, value] of Object.entries(affinityHeader)) {
        res.setHeader(name, value);
      }
    }
    this.respondUncommitted(res, 502, { error: describeAllCandidatesFailed(model, candidates.length, lastError) });
  }

  /**
   * Close out a routed request whose client left. Before headers the row is still pending and is
   * settled as failed with no status — nothing was served — and it is logged, because a client giving
   * up on a turn that had not started answering is the one symptom of a queue too slow for its callers.
   * After headers the row already says served, which it was, and a stopped generation is routine.
   *
   * The row KEEPS the node, peer and engine it was waiting on, and says `clientClosed`. Nulling them
   * — which this did until beta-max, 2026-09-21 — left a row identical to the one a request that
   * exhausted every candidate settles as, and the log's NODE column is where an operator looks first:
   * four rows reading `qwen3-coder:30b  -  1/14  30031  x failed` were reported as "placement returns
   * no candidate and times out" when placement had ranked fourteen candidates and the caller had
   * given up on the first after 30 s. A request that ends because nobody is waiting for it is not a
   * routing failure, and the log has to be able to say which of the two it is looking at.
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
      // `node`, `peerId` and `backend` are deliberately absent: `settle` keeps what placement wrote,
      // and what placement wrote is the candidate that was still holding this request.
      attempt: index + 1,
      outcome: 'failed',
      clientClosed: true,
      status: null,
      durationMs: waitedMs,
    });
    this.logger.log(`[PoolProxy] client closed the request after ${waitedMs}ms while ${nodeLabel} had not answered; upstream request aborted`);
  }

  /**
   * The Hub's residency arbitration for a generation about to go to this node's own engine: keep a
   * tracked model resident, or make room for it and load it, before the engine sees the request.
   * Every app's inference to this node crosses the routed walk, so it is the one place arbitration
   * can apply to all of them. Read-only natives (`/api/tags`, `/api/ps`, `/api/show`) never get here:
   * they go through `proxyLocalOnlyRequest`.
   *
   * Returns why the Hub refused the load this request needed on `candidate`'s engine, or null when
   * nothing stands in the way: the model is resident, is not one the Hub tracks, was loaded, or the
   * arbitration itself failed, which leaves the engine to do what it always did. A refusal for a
   * model the Hub tracks on another local engine is not this candidate's either.
   *
   * The load is `InferenceRouterService.loadTrackedModel` with origin `request`, as
   * `prepareTrackedModel` makes it, and the model is found as that method finds it: by catalog id or
   * by engine tag (`sameModelId`, so `:latest` folds), loaded only from `pulled`. It is not called
   * through `prepareTrackedModel`, because that method answers "not a model the Hub tracks" and "the
   * Hub refused to load it" with the same null, and the walk sends the first to the engine and moves
   * the second behind the other candidates. It drops the reason too, which the routing row needs.
   *
   * Skipped once the client has hung up: arbitration is what loads or evicts a model, the most
   * expensive thing on this path (a 27B reload measured ~168 s on core-6), and nobody would use the
   * room made. The signal goes with it, because arbitration queues: a request that hangs up while it
   * waits behind another model's cold load must not go on to evict and load for nobody. A refusal
   * that comes back after the hang-up is not reported, since there is no walk left to reorder.
   */
  private async arbitrateLocalLoad(
    candidate: PoolCandidate,
    path: string,
    body: unknown,
    model: string,
    clientClosed: AbortSignal,
  ): Promise<LocalLoadRefusal | null> {
    const router = this.router;
    const registry = this.modelRegistry;
    if (!GENERATION_PATHS.has(path) || !router || !registry || clientClosed.aborted) {
      return null;
    }
    const tracked = registry.getTrackedModel(model) ?? registry.getTrackedModels().find((entry) => sameModelId(entry.backendModelId, model));
    // Resident as far as the registry knows (`loaded`, `pinned`), not the Hub's, or not on disk yet:
    // nothing for the Hub to load, and the request goes to the engine as it always did.
    if (tracked?.state !== 'pulled') {
      return null;
    }
    // With the window this request will run at, so a model loaded for it is loaded at that window and
    // the request itself does not reload it (none on `/v1`: Ollama's default).
    const numCtx = requestedWindow(path, body);
    try {
      const outcome = await router.loadTrackedModel(tracked.catalogId, { origin: 'request', numCtx, signal: clientClosed });
      if (outcome.loaded || clientClosed.aborted) {
        return null;
      }
      if (tracked.backend !== candidate.backend) {
        this.logger.debug(
          `[PoolProxy] the Hub refused to load "${model}" on ${tracked.backend} (${outcome.reason}); ${candidate.backend} serves it here, so that is not its refusal`,
        );
        return null;
      }
      return { reason: outcome.reason, idleWouldFree: outcome.idleWouldFree === true };
    } catch (error) {
      this.logger.debug(
        `[PoolProxy] residency arbitration for ${model} failed; forwarding anyway: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * A refusal that only generations in progress caused, waited out: the Hub looks again each time the
   * models busy on the engine change, up to {@link BUSY_MODEL_WAIT_MS}. Returns null once the load was
   * made or the client left, else the latest refusal (still waiting on busy models at the deadline, or
   * refused for another reason now they are idle), which the caller then handles as any other.
   *
   * A model the Hub did not load stays protected: this only lets the Hub's own idle loads be unloaded,
   * as the request path always could, once nothing is running on them.
   */
  private async awaitBusyModels(
    candidate: PoolCandidate,
    path: string,
    body: unknown,
    model: string,
    clientClosed: AbortSignal,
    refusal: LocalLoadRefusal,
  ): Promise<LocalLoadRefusal | null> {
    // Without this request's own model: it is already counted in flight, and is not what is being waited for.
    const busyElsewhere = (): string =>
      this.loadService
        .localBusyModelsOn(candidate.backend)
        .filter((work) => !sameModelId(work.model, model))
        .map((work) => work.model)
        .sort()
        .join(',');
    const deadline = Date.now() + BUSY_MODEL_WAIT_MS;
    this.logger.log(
      `[PoolProxy] "${model}" is waiting up to ${BUSY_MODEL_WAIT_MS / 1000}s for ${busyElsewhere() || 'the models running on it'} to finish before it is loaded on ${candidate.backend} here`,
    );
    let current: LocalLoadRefusal | null = refusal;
    let watching = busyElsewhere();
    while (current?.idleWouldFree && Date.now() < deadline) {
      await sleepUnlessAborted(BUSY_MODEL_POLL_MS, clientClosed);
      if (clientClosed.aborted) return null;
      const now = busyElsewhere();
      if (now === watching) continue;
      watching = now;
      current = await this.arbitrateLocalLoad(candidate, path, body, model, clientClosed);
    }
    return current;
  }

  /**
   * One line per failover, naming the node, what it answered and why it was passed over. Without it
   * a failover was visible only in the routing log's `failedOverFrom`: two 2026-09-29 failovers from
   * beta-1 to core-17 left no line on either Hub. At warn for a node failing (a 5xx, an output fault),
   * at log for one saying "not now" (408/429) or refusing the pairing, which is load shedding or has
   * a warning of its own.
   */
  private logFailover(model: string, candidate: PoolCandidate, nodeLabel: string, status: number | null, reason: string, left: number): void {
    const line =
      `[PoolProxy] ${nodeLabel} (${candidate.backend}) failed "${model}": ${reason}; ` +
      (left > 0 ? `failing over (${left} candidate(s) left)` : 'no candidate left');
    if (status !== null && status >= 400 && status < 500) {
      this.logger.log(line);
    } else {
      this.logger.warn(line);
    }
  }

  /**
   * {@link applyOutputQuarantine} against this node's output strikes. The affinity decision is
   * corrected when the engine it put first was moved back, so the row does not claim a `hit` that
   * was not placed first. One debug line when anything moved; the warn was written when it was withheld.
   */
  private demoteWithheldEngines(model: string, ranked: PoolCandidate[], affinity: PoolRoutingAffinity | null): PoolCandidate[] {
    if (this.outputQuarantine.isEmpty()) {
      return ranked;
    }
    const { candidates, withheld } = applyOutputQuarantine(ranked, (candidate) =>
      this.outputQuarantine.isWithheld({ nodeKey: candidate.peerId ?? LOCAL_CANDIDATE_KEY, backend: candidate.backend, model }),
    );
    if (withheld.length === 0) {
      return ranked;
    }
    if (affinity?.outcome === 'hit' && ranked[0] && withheld.includes(ranked[0])) {
      affinity.outcome = 'skipped';
    }
    this.logger.debug(
      `[PoolProxy] "${model}" moved ${withheld.map((candidate) => `${candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY} ${candidate.backend}`).join(', ')} behind every other candidate: withheld after answering with bad output`,
    );
    return candidates;
  }

  /**
   * One cut-off or degenerate answer, struck against the engine that gave it. The strike that
   * withholds it is the one warn line an operator gets for the whole run of them, and says why; every
   * answer is on its routing row either way.
   */
  private strikeOutput(target: OutputTarget, fault: PoolOutputFault, nodeLabel: string): void {
    const decision = this.outputQuarantine.strike(target, fault);
    if (!decision.withheld) {
      this.logger.debug(
        `[PoolProxy] ${nodeLabel} ${target.backend} answered "${target.model}" with ${describeOutputFault(fault)}; strike ${decision.strikes} of ${QUARANTINE_STRIKES}`,
      );
      return;
    }
    const why =
      decision.strikes > 1
        ? `${decision.strikes} times within ${Math.round(STRIKE_WINDOW_MS / 60_000)} minutes`
        : 'again, on its first request after the last withhold ran out';
    this.logger.warn(
      `[PoolProxy] ${nodeLabel} ${target.backend} answered "${target.model}" with ${describeOutputFault(fault)} ${why}; ` +
        `withholding it from routing for ${Math.round(decision.forMs / 1000)}s — every other candidate is tried first`,
    );
  }

  /** A clean, complete answer clears the engine's strikes, and ends a withhold outright. */
  private clearOutputStrikes(target: OutputTarget, nodeLabel: string): void {
    if (this.outputQuarantine.isEmpty()) {
      return;
    }
    if (this.outputQuarantine.clear(target)) {
      this.logger.log(`[PoolProxy] ${nodeLabel} ${target.backend} answered "${target.model}" cleanly again — no longer withheld from routing`);
    }
  }

  /**
   * A relayed stream's verdict, once it has ended: a fault turns the row `failed` on the node's account
   * and strikes the engine, a clean complete answer clears it. `true` when the stream was faulty. A
   * stream that was cut, by either end, has no verdict and changes nothing here.
   */
  private settleStreamVerdict(row: PoolRoutingRecord, verdict: OutputVerdict | null, target: OutputTarget, nodeLabel: string): boolean {
    if (!verdict) {
      return false;
    }
    if (verdict.fault) {
      this.routingLog.update(row, {
        outcome: 'failed',
        requestError: { signature: verdict.fault, basis: 'node', confirms: null },
        reason: verdict.fault,
      });
      this.strikeOutput(target, verdict.fault, nodeLabel);
      return true;
    }
    if (verdict.complete) {
      this.clearOutputStrikes(target, nodeLabel);
    }
    return false;
  }

  /**
   * Whether a request placed on `candidate` now can be timed as that engine's speed: nothing else in
   * flight there as far as this node can tell — its own counter for the local engine, and for a peer
   * both what we have forwarded and what its fresh snapshot reported. An unknown load is not idle.
   */
  private idleForMeasurement(candidate: PoolCandidate, peers: readonly HubPoolPeer[]): boolean {
    if (candidate.peerId === null) {
      return this.loadService.localInFlight() === 0;
    }
    const peer = peers.find((row) => row.id === candidate.peerId);
    const capabilities = peer?.lastCapabilities as unknown as PoolPeerCapabilities | null | undefined;
    return !!peer && !!capabilities && this.peerLoad(peer, capabilities) === 0;
  }

  /**
   * One served response as throughput evidence. Prefill is the engine's own figure when it reported
   * one, since that leaves out the model load and the queue; otherwise, for a streamed request, the
   * wait for the first chunk. A non-streamed request with no engine timings says nothing about
   * prefill, because its wait was the whole generation. Decode is reported, never ranked on.
   *
   * Either prefill figure goes with what the engine said about its prompt cache, when it said anything:
   * a turn is timed on the part it read, and one that read fewer than `PREFILL_MIN_READ_TOKENS` is not
   * timed at all — see `HubPoolThroughputService.recordPrefill`. Timed against the whole prompt,
   * a cache hit reads as hundreds of thousands of tokens a second (Ollama 0.34.4 read a 7,615-token
   * prompt in 2,735 ms cold and 19 ms warm), and a node that answered warm turns would be placed as if
   * it read cold ones that fast.
   */
  private recordServedThroughput(
    target: ThroughputTarget,
    streaming: boolean,
    promptBytes: number,
    startedAt: number,
    headersAt: number,
    timing: ResponseTiming,
  ): void {
    const prefillMs = timing.engine?.promptMs ?? (streaming ? (timing.firstChunkAt ?? headersAt) - startedAt : null);
    if (prefillMs !== null) {
      this.throughput.recordPrefill(target, {
        promptTokens: estimatePromptTokens(promptBytes),
        ms: prefillMs,
        deadline: false,
        read: timing.promptRead,
      });
    }
    const engine = timing.engine;
    if (engine && engine.completionTokens !== null && engine.decodeMs !== null) {
      this.throughput.recordDecode(target, { tokens: engine.completionTokens, ms: engine.decodeMs });
    } else if (streaming && timing.usage?.completionTokens != null && timing.firstChunkAt !== null && timing.completedAt !== null) {
      this.throughput.recordDecode(target, { tokens: timing.usage.completionTokens, ms: timing.completedAt - timing.firstChunkAt });
    }
  }

  /**
   * A streamed forward that ran out of its budget as "at least this slow" evidence. It carries no usage
   * frame, and it is the most important sample there is: the failure placement exists to stop repeating.
   */
  private recordMissedDeadline(target: ThroughputTarget, promptBytes: number, startedAt: number, error: unknown): void {
    if (!isForwardDeadline(error)) {
      return;
    }
    const waited = Math.max(Date.now() - startedAt, error instanceof PoolForwardDeadlineError ? error.budgetMs : 0);
    this.throughput.recordPrefill(target, { promptTokens: estimatePromptTokens(promptBytes), ms: waited, deadline: true });
  }

  /**
   * Whether a candidate's response status should send us to the next candidate. Depends on the
   * candidate *kind*: a peer answers 401/403/404 about the pairing itself (its PoolPeerGuard, its
   * `forwardLocal` connected-check), which says nothing about the application's request — whereas
   * the same status from the local engine is the engine's verdict on the request and is passed
   * through untouched. A 401/403 a peer relays from its engine fails over too — that engine's key is
   * the peer's to fix, and another node may serve — but `proxyRequest` relays it from the last
   * candidate instead, and {@link noteRejectedCandidate} leaves the pairing alone.
   *
   * Status alone. The one 5xx that is not a reason to move on — a 500 whose body blames the request —
   * is decided before this is asked, in `proxyRequest`, because it needs the body.
   */
  private shouldFailover(candidate: PoolCandidate, status: number): boolean {
    if (status >= 500) {
      return true;
    }
    return candidate.peerId === null ? TRANSPORT_4XX.has(status) : PEER_TRANSPORT_4XX.has(status);
  }

  /**
   * Feed a local engine's own answer back into its serving-capability signal, so the next
   * `probeLocalCandidates` knows something this request found out and no health poll could.
   *
   * Only 5xx counts as a failure. 408 and 429 fail over too, but they are the engine saying "not
   * now" about its queue, not "not ever" about the model — withholding a model because the node
   * was briefly busy would turn load shedding into an outage. Peers are skipped entirely: a peer's
   * capabilities are its own to correct (see {@link noteRejectedCandidate}), and a 500 relayed
   * through it says nothing about which of ITS backends failed.
   */
  private noteLocalServing(candidate: PoolCandidate, model: string, status: number, verdict: PoolRequestErrorVerdict | null): void {
    if (candidate.peerId !== null) {
      return;
    }
    this.noteLocalServingOutcome(candidate.backend, model, status, verdict);
  }

  /**
   * The rule itself, shared by the outbound path ({@link noteLocalServing}) and the peer-facing
   * inbound forward, so a model's serving record does not depend on which door the request came in.
   *
   * A 500 whose body is an engine's verdict on the request is no strike either, unless the verdict
   * could be the node's own fault (see `strikesModel`). Two strikes inside five minutes withhold the
   * model, so without this an agent retrying one malformed turn withholds a healthy model on every
   * node its retries reach.
   */
  private noteLocalServingOutcome(
    backendType: InferenceBackendType,
    model: string | undefined,
    status: number,
    verdict: PoolRequestErrorVerdict | null = null,
  ): void {
    if (!model) {
      return;
    }
    const backend = this.backends.tryGet(backendType);
    // A verdict that flipped the model's withheld state has changed what `healthCheck()` will
    // report as `unservableModels`, and the snapshot placement reads is a copy of the last one.
    // Dropping it here is what keeps quarantine request-accurate rather than TTL-accurate: the
    // next request re-probes this backend instead of offering a model the node just failed.
    if (status >= 500) {
      if (verdict && !verdict.strikesModel) {
        return;
      }
      if (backend?.noteServingFailure?.(model, `HTTP ${status}`)) {
        this.localHealth.invalidate(backendType);
      }
      return;
    }
    if (status < 400) {
      // A 4xx is the engine's verdict on the *request*, not proof the model can run, so only a
      // clean response clears the record.
      if (backend?.noteServingSuccess?.(model)) {
        this.localHealth.invalidate(backendType);
      }
    }
  }

  /**
   * A peer that 401/403s no longer treats us as paired, so its cached model list is stale — stop
   * offering it until the next successful health probe.
   *
   * Unless the peer marked the answer as its engine's (see {@link isRelayedEngineResponse}): then an
   * engine behind it refused the key the peer holds for it, the pairing is intact, and every other
   * engine there still serves. Warned about, because only that peer's operator can fix it, and left
   * at that.
   */
  private async noteRejectedCandidate(candidate: PoolCandidate, status: number, headers: Headers): Promise<void> {
    if (candidate.peerId === null || !PEER_PAIRING_STATUSES.has(status)) {
      return;
    }
    if (isRelayedEngineResponse(headers)) {
      this.warnPeerEngineRefusal(candidate, status, 'asking the next candidate');
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

  /**
   * The operator's line for a peer's engine refusing the key that peer holds for it — a vLLM,
   * Lemonade or oMLX key mismatch there (see {@link isRelayedEngineResponse}) — whether the walk
   * went on past it or relayed it from the last candidate. Only that peer's operator can fix it.
   * At warn once per {@link PEER_ENGINE_REFUSAL_WARN_INTERVAL_MS} for each peer, engine and status,
   * and at debug in between, because the peer stays a candidate and the refusal recurs.
   */
  private warnPeerEngineRefusal(candidate: PoolCandidate, status: number, then: string): void {
    const line = `[PoolProxy] peer ${candidate.nodeFqdn}'s ${candidate.backend} engine answered ${status} to the request it relayed: check the API key that peer holds for it. Its pairing is fine, so it keeps its cached capabilities; ${then}`;
    const key = `${candidate.peerId}\n${candidate.backend}\n${status}`;
    const now = Date.now();
    const warnedAt = this.peerEngineRefusalWarnedAt.get(key);
    if (warnedAt !== undefined && now - warnedAt < PEER_ENGINE_REFUSAL_WARN_INTERVAL_MS) {
      this.logger.debug(line);
      return;
    }
    this.peerEngineRefusalWarnedAt.set(key, now);
    this.logger.warn(line);
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
    /** The sender's routing-log id, from `X-Hub-Pool-Request-Id`, already normalised. Optional for the same reason as `model`. */
    requestId?: string,
  ): Promise<void> {
    // Counted like a locally-routed request: a peer's forwarded work occupies this node's engine
    // exactly as its own apps' does, and a node busy serving the pool must not report itself idle
    // to the very peers deciding whether to send it more.
    const startedAt = Date.now();
    // The sending node aborting its own fetch closes this response, and this is the node whose engine
    // is doing the prefill — so the close has to be carried one hop further, to the engine.
    const watch = watchClient(res);
    const senderClosed = watch.clientClosed;
    // The model for the row and the output strikes; the serving record keeps reading the header alone.
    const rowModel = forwardedModel(model, body) ?? null;
    // Timed exactly like a request this node's own apps sent here, because it is the same engine
    // doing the same work — and a node that mostly serves peers learns its own speed only this way.
    // It reads the response for timing frames as the outbound tap does, and never the request body.
    const target: ThroughputTarget | null =
      model && PROMPT_CEILING_PATHS.has(path) && this.loadService.localInFlight() === 0 ? { nodeKey: LOCAL_CANDIDATE_KEY, backend, model } : null;
    const streaming = isStreamingRequest(body, path);
    const payload = forwardedPayload(method, body);
    // A peer's turn holds a runner here exactly as a local app's does, so it is named the same way.
    const generation: LocalGeneration | undefined =
      model && PROMPT_CEILING_PATHS.has(path) ? { backend, model, numCtx: requestedWindow(path, body) } : undefined;
    const embedding: LocalModelWork | undefined = model && EMBEDDING_PATHS.has(path) ? { backend, model } : undefined;
    this.loadService.acquire(LOCAL_CANDIDATE_KEY, generation, embedding);
    // Recorded once per forward, whichever way it ends: a stream that dies after the backend
    // answered is the same routing decision, not a second one.
    let row: PoolRoutingRecord | null = null;
    const request = { id: requestId, ...describeRequestShape(method, body, path) };
    // This node's engine is the one answering, so this node strikes it too — for its own apps'
    // next requests. The sender judges the same bytes and keeps its own account of this engine.
    const dialect = outputDialectOf(path);
    try {
      const upstream = await this.callBackend(backend, path, method, body, payload, senderClosed);
      const headersAt = Date.now();
      // A peer's forward is the only evidence an inbound-only node ever gets that one of its own
      // models cannot run: nothing here goes through `proxyRequest`, so without this the node
      // earns no strikes, withholds nothing, and keeps advertising the dead model to its peers.
      // The metadata exemption stays on the model argument: describing a model is not evidence that
      // it serves, so a peer-forwarded `/api/show` must not credit or strike its serving record.
      // The error body is read from a clone, so the sender still gets it whole and judges it itself.
      const verdict = await readRequestErrorVerdict(upstream);
      // Logged from the receiving side too, so an operator can answer "which of my peers is
      // spending my GPU time" — the sender's own log only covers what it sent. An error status says
      // why on the row, which until 2026-09-29 read a bare 500 on beta-1 for every turn it failed.
      row = this.recordInbound({
        backend,
        path,
        fromPeerFqdn,
        model: rowModel,
        status: upstream.status,
        startedAt,
        request,
        reason: upstream.status >= 400 ? describeStatusReason(upstream.status, verdict?.signature) : null,
      });
      this.noteLocalServingOutcome(backend, MODEL_METADATA_PATHS.has(path) ? undefined : model, upstream.status, verdict);
      // Marks the answer as the engine's, so the sender can tell an engine refusing its key here
      // from this Hub refusing the pairing: see `isRelayedEngineResponse`. The sender drops every
      // `x-hub-pool-*` header from a peer's answer, so the caller never sees it.
      const relayed = { [POOL_BACKEND_HEADER]: backend };
      const meter = target && upstream.ok ? startResponseTiming() : null;
      const judge =
        dialect && upstream.ok ? new OutputJudge(dialect, streaming || isStreamedContentType(upstream.headers.get('content-type'))) : null;
      this.commitResponse(upstream, res, relayed);
      const settledRow = row;
      let relayCut = false;
      try {
        await this.streamResponse(upstream, res, watch, {
          onUsage: meter
            ? (usage) => {
                meter.timing.usage = usage;
              }
            : undefined,
          observer: meter?.observer,
          judge,
        });
      } catch (error) {
        relayCut = error instanceof RelayError && error.side === 'upstream';
        throw error;
      } finally {
        // Not from an answer that failed on this engine's account — see the same guard in `routeRequest`.
        if (meter && target && !relayCut && !judge?.verdict()?.fault) {
          this.recordServedThroughput(target, streaming, payload?.length ?? 0, startedAt, headersAt, meter.timing);
        }
        this.routingLog.update(settledRow, { totalMs: Date.now() - startedAt });
      }
      const judged = judge?.verdict();
      if (judged?.fault) {
        this.routingLog.update(settledRow, { outcome: 'failed', reason: judged.fault });
        if (rowModel) this.strikeOutput({ nodeKey: LOCAL_CANDIDATE_KEY, backend, model: rowModel }, judged.fault, LOCAL_CANDIDATE_KEY);
      } else if (judged?.complete && rowModel) {
        this.clearOutputStrikes({ nodeKey: LOCAL_CANDIDATE_KEY, backend, model: rowModel }, LOCAL_CANDIDATE_KEY);
      }
    } catch (error) {
      if (!row) {
        // A sender that gave up on this forward is not this node failing it, and says so: the sender's
        // walk moved on, or its caller left, and counting it failed here read as a peer failure.
        this.recordInbound({
          backend,
          path,
          fromPeerFqdn,
          model: rowModel,
          status: null,
          startedAt,
          request,
          clientClosed: senderClosed.aborted,
          reason: senderClosed.aborted ? null : describeAttemptError(error),
        });
        if (target && streaming) {
          this.recordMissedDeadline(target, payload?.length ?? 0, startedAt, error);
        }
      } else if (!senderClosed.aborted && error instanceof RelayError && error.side === 'upstream') {
        // The engine died mid-answer: the sender got a cut-off response from this node, and this
        // node's own apps would get the same, so it is struck here as a judged cut-off answer is.
        this.routingLog.update(row, { outcome: 'failed', reason: 'truncated-upstream' });
        if (dialect && rowModel) {
          this.strikeOutput({ nodeKey: LOCAL_CANDIDATE_KEY, backend, model: rowModel }, 'truncated-upstream', LOCAL_CANDIDATE_KEY);
        }
      }
      if (senderClosed.aborted) {
        // Nobody to answer: rethrowing would only have Nest log a routine hang-up as a server error
        // and try to write a 500 to a closed socket.
        this.logger.debug(`[PoolProxy] ${fromPeerFqdn ?? 'a peer'} closed its forward of ${path}; local engine request aborted`);
        return;
      }
      throw error;
    } finally {
      this.loadService.release(LOCAL_CANDIDATE_KEY, generation, embedding);
      watch.dispose();
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
    /** The sender's routing-log id, when it sent one — so a refusal joins to the sender's failover row too. */
    requestId?: string;
    /** The model the forward was for, when the sender named it — see {@link forwardedModel}. */
    model?: string;
    /** Why it was refused, in the row's few words. */
    reason?: string;
  }): void {
    // 'failed' explicitly: nothing was served. The rule below now reads a 4xx as failed too, but that
    // rule describes an engine's answer, and a refusal at the door should not depend on it.
    this.recordInbound({
      backend: params.backend,
      path: params.path,
      fromPeerFqdn: params.fromPeerFqdn,
      model: params.model ?? null,
      status: params.status,
      startedAt: Date.now(),
      outcome: 'failed',
      request: { id: params.requestId },
      reason: params.reason ?? describeStatusReason(params.status),
    });
  }

  private recordInbound(entry: {
    backend: InferenceBackendType | null;
    path: string;
    fromPeerFqdn: string | undefined;
    model: string | null;
    status: number | null;
    startedAt: number;
    outcome?: PoolRoutingOutcome;
    request?: Pick<PoolRoutingRecordInput, 'id' | 'stream' | 'bodyBytes' | 'budgetMs'>;
    reason?: string | null;
    clientClosed?: boolean;
  }): PoolRoutingRecord {
    const { backend, path, fromPeerFqdn, status, startedAt, outcome } = entry;
    return this.routingLog.record({
      ...entry.request,
      at: new Date().toISOString(),
      direction: 'inbound',
      path,
      // The sender's `X-Hub-Pool-Model`, or the body's own `model`: the body is passed through
      // untouched, and only that one field of it is read.
      model: entry.model,
      node: fromPeerFqdn ?? null,
      peerId: null,
      backend,
      candidates: 1,
      attempt: 1,
      failedOverFrom: [],
      // Always null: a pin is THIS Hub's policy for work it originates. Work a peer forwards us is
      // never re-routed (see `forwardToLocalBackendAndRespond`), so no pin can have shaped it.
      pin: null,
      // Null for the same reason as the pin: the ceiling and the cap are applied by the node choosing where work goes.
      promptCeiling: null,
      contextCap: null,
      slots: null,
      throughput: null,
      contention: null,
      affinity: null,
      // Below 400 only: a 4xx is the engine refusing the peer's request, which served nothing. The
      // row carries no `requestError` — see the field — and its status says what happened.
      outcome: outcome ?? (status !== null && status < 400 ? 'served' : 'failed'),
      status,
      durationMs: Date.now() - startedAt,
      // Inbound (peer-forwarded) usage capture is out of scope for now — see the PR description.
      // `forwardToLocalBackendAndRespond` taps the response for timings only, not for this row.
      usage: null,
      reason: entry.reason ?? null,
      clientClosed: entry.clientClosed ?? false,
    });
  }

  /**
   * Best-effort passthrough for the endpoints that carry no `model` field and so can't be routed
   * across the pool — `GET /v1/models`, `GET /api/tags`, `GET /api/ps`, `GET /api/version`,
   * `POST /api/show`. Tries this node's own backends in order and serves the first that answers.
   *
   * The two *listing* paths are the exception: they are served by {@link serveMergedListing}, which
   * adds what connected peers hold to what this node answered. Everything else is still a local
   * passthrough, because there is nothing coherent to merge — `/api/ps` is about this machine's
   * memory, `/api/version` about this machine's engine, and `/api/show` is a lookup that falls back
   * to a peer wholesale rather than blending.
   */
  async proxyLocalOnlyRequest(path: string, method: string, body: unknown, res: Response): Promise<void> {
    const watch = watchClient(res);
    try {
      await this.serveLocalOnly(path, method, body, res, watch);
    } finally {
      watch.dispose();
    }
  }

  private async serveLocalOnly(path: string, method: string, body: unknown, res: Response, watch: ResponseCloseWatch): Promise<void> {
    const clientClosed = watch.clientClosed;
    if (MERGED_LISTING_PATHS.has(path)) {
      await this.serveMergedListing(path, method, res, clientClosed);
      return;
    }
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
        // `undefined` payload: let callBackend serialise the body itself, as it did before #1497 gave
        // the routed path a pre-measured one to reuse. Nothing local-only is measured for throughput.
        const upstream = await this.callBackend(type, path, method, resolvedBody, undefined, clientClosed);
        if (!upstream.ok) {
          this.logger.debug(`[PoolProxy] ${path} via local ${type} answered ${upstream.status}; trying the next backend`);
          continue;
        }
        this.commitResponse(upstream, res);
        committed = true;
        await this.streamResponse(upstream, res, watch);
        return;
      } catch (error) {
        this.logger.debug(`[PoolProxy] ${path} via local ${type} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (committed || clientClosed.aborted) {
          res.destroy();
          return;
        }
      }
    }
    if (MODEL_METADATA_PATHS.has(path) && (await this.describeFromPeer(path, resolvedBody, res, watch))) {
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
   * `GET /v1/models` / `GET /api/tags`, answered for the POOL rather than for this node.
   *
   * Three things it fixes, all of which were visible on the fleet:
   * - A client was told this node's models and then found a model it had never been offered served
   *   fine, because a peer held it. The listing was the only surface still answering for one node.
   * - A Hub whose own engines are down or absent answered 502 while its peers held a dozen models.
   *   The local half is now allowed to fail without failing the request.
   * - `auto` resolves pool-wide, so the model a listing did not mention is routinely the one that
   *   runs.
   *
   * The peer half costs no network I/O — it reads `hub_pool_peer.last_capabilities`, the snapshot
   * the health poll already refreshes and the ranker already reads, so the listing and the next
   * completion cannot disagree. Ranking is not consulted: this answers "what may I ask for", not
   * "where would it run".
   *
   * Buffered rather than streamed, unlike every other path here. A merged body has to be built
   * before any of it can be written, and a model list is small — the streaming path exists for
   * generations, which this is not.
   */
  private async serveMergedListing(path: string, method: string, res: Response, clientClosed: AbortSignal): Promise<void> {
    const local = await this.localListing(path, method, clientClosed);
    if (clientClosed.aborted) {
      res.destroy();
      return;
    }

    const peers = await this.usablePeers().catch((error: unknown) => {
      // A peer read that fails must not take down a listing this node answered on its own. It
      // degrades to exactly the pre-pool behaviour, which is what an operator with no peers gets.
      this.logger.debug(`[PoolProxy] ${path} could not read peer inventories: ${error instanceof Error ? error.message : String(error)}`);
      return [] as HubPoolPeer[];
    });
    const peerModels = peers.flatMap((peer) => this.peerServableInventory(peer).backends.flatMap((backend) => backend.models));
    const extra = peerOnlyModels(listedModelIds(path, local), peerModels);

    if (local === null && extra.length === 0) {
      // Nothing anywhere. Keep the old 502 and the old warn: a caller probing this route to decide
      // whether the Hub speaks Ollama natively reads the failure, not the body.
      if (NATIVE_CAPABILITY_PROBE_PATHS.has(path)) {
        this.logger.warn(
          `[PoolProxy] no local backend could serve ${path}; a caller probing this route to decide native-vs-OpenAI-compatible ` +
            'routing (e.g. ci-hermes) will silently fall back to /v1 and lose per-request context-length control.',
        );
      }
      this.respondUncommitted(res, 502, { error: `No local backend able to serve ${path}` });
      return;
    }

    if (extra.length > 0) {
      this.logger.debug(`[PoolProxy] ${path} merged ${extra.length} peer-only model(s) from ${peers.length} peer(s)`);
    }
    this.respondUncommitted(res, 200, mergeModelListing(path, local, extra));
  }

  /**
   * Every healthy local backend's listing, merged (`mergeLocalListings`), or the first backend's
   * alone when at most one is healthy. Only the backends the health snapshot calls healthy are asked,
   * and in parallel: a client may fetch this before every request (ci-server checks its model against
   * it per call), and an unconfigured backend's URL can sit behind a host firewall that drops rather
   * than refuses — one listing must not wait out a connect timeout per absent engine.
   *
   * Nor does it wait on a healthy engine that has stopped answering: each backend gets
   * `LOCAL_LISTING_DEADLINE_MS` from the start, and one still out then is left out of this listing
   * when another has answered (see `gatherListings`). The health snapshot is up to a poll old, and an
   * engine wedged since it was taken used to hold the listing for the whole forward budget.
   */
  private async localListing(path: string, method: string, clientClosed: AbortSignal): Promise<unknown> {
    const healthy = await this.localHealth
      .read()
      .then((snapshot) => snapshot.filter(({ health }) => health.running && health.healthy).map(({ type }) => type))
      .catch(() => [] as InferenceBackendType[]);
    if (healthy.length <= 1) {
      return this.firstLocalListing(path, method, clientClosed);
    }
    const answered = await gatherListings(
      INFERENCE_BACKEND_TYPES.filter((type) => healthy.includes(type)),
      async (type, dropped) => {
        try {
          const upstream = await this.callBackend(type, path, method, undefined, undefined, AbortSignal.any([clientClosed, dropped]));
          if (!upstream.ok) {
            this.logger.debug(`[PoolProxy] ${path} via local ${type} answered ${upstream.status}; leaving it out of the listing`);
            return null;
          }
          return (await upstream.json()) as unknown;
        } catch (error) {
          // A backend dropped for its deadline was logged when it was dropped.
          if (!dropped.aborted) {
            this.logger.debug(`[PoolProxy] ${path} via local ${type} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return null;
        }
      },
      LOCAL_LISTING_DEADLINE_MS,
      (type) =>
        this.logger.debug(
          `[PoolProxy] ${path} via local ${type} had not answered within ${LOCAL_LISTING_DEADLINE_MS}ms; leaving it out of the listing`,
        ),
    );
    return answered.length === 0 ? this.firstLocalListing(path, method, clientClosed) : mergeLocalListings(path, answered);
  }

  /**
   * The first local backend's parsed listing body, or `null` when none answered with usable JSON.
   *
   * `null` is not an error here. A Hub with no local engine is a legitimate pool member — it exists
   * to send work to peers — and its listing should describe what the pool can do, not fail.
   */
  private async firstLocalListing(path: string, method: string, clientClosed: AbortSignal): Promise<unknown> {
    for (const type of INFERENCE_BACKEND_TYPES) {
      if (clientClosed.aborted) return null;
      try {
        const upstream = await this.callBackend(type, path, method, undefined, undefined, clientClosed);
        if (!upstream.ok) {
          this.logger.debug(`[PoolProxy] ${path} via local ${type} answered ${upstream.status}; trying the next backend`);
          continue;
        }
        return await upstream.json();
      } catch (error) {
        this.logger.debug(`[PoolProxy] ${path} via local ${type} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
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
  private async describeFromPeer(path: string, body: unknown, res: Response, watch: ResponseCloseWatch): Promise<boolean> {
    const clientClosed = watch.clientClosed;
    const model = isRecord(body)
      ? [body.model, body.name].find((value): value is string => typeof value === 'string' && value.length > 0)
      : undefined;
    if (!model) {
      return false;
    }
    // No `prompt`, and that omission is the point rather than an oversight. Both prompt-size
    // decisions it gates — the operator's ceiling and the measured-throughput demotion — are
    // statements about how long a TURN a node takes to prefill, and a metadata lookup is not a turn:
    // the peer answers it from metadata already on disk, in under 0.3 s on every node measured,
    // whatever the body says. Judging it would compare a node's turn budget against a number that
    // has nothing to do with one, and walk past the node best placed to answer instantly.
    // Belt-and-braces with `PROMPT_CEILING_PATHS`, which lists only the four generation paths and so
    // already excludes every {@link MODEL_METADATA_PATHS} entry on the `proxyRequest` side; keep
    // both, because they guard different callers.
    //
    // `occupiesSlot: false` for the same reason, against the third placement decision: slot-aware
    // placement moves a node whose `OLLAMA_NUM_PARALLEL` slots are full behind every node with a
    // free one, because a forwarded request would queue behind the engine there. This lookup takes
    // no slot — `/api/show` is answered by the daemon from metadata on disk, not by a loaded model —
    // so a full node is exactly as quick to answer it as an idle one, and demoting it would walk
    // past the node the ranker chose over a queue the lookup never joins. Embeddings keep the pass:
    // they occupy a slot like any turn.
    const { candidates } = await this.rankCandidates(model, undefined, false);
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
        await this.streamResponse(upstream, res, watch);
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
      // No request id: a metadata lookup opens no routing-log row on either side, so there is no
      // outbound row for a peer's inbound row to be correlated with.
      return await this.forward(candidate, path, 'POST', body, model, undefined, undefined, AbortSignal.any([clientClosed, headersDeadline.signal]));
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
  /**
   * This node's candidates for `model`, plus what every local backend said on the way — the
   * probes are what a no-candidate 502 reports, so the same health answer serves both.
   *
   * "Said" is the snapshot's word, not a live probe's: `HubPoolLocalHealthService` is what keeps
   * a DROPped engine port from costing every request its 5 s transport timeout. The order is the
   * registry's, not whichever engine answered first, because the ranker's stable sort turns it
   * into the local tie-break.
   */
  private async probeLocalCandidates(model: string): Promise<{ candidates: PoolCandidate[]; probes: LocalBackendProbe[] }> {
    const snapshot = await this.localHealth.read();
    // Taken after the read, which can hold a cold request for the placement budget.
    const now = Date.now();
    const results = snapshot.map(
      ({ type, backend, health, probedAt }: LocalBackendHealth): { candidate: PoolCandidate | null; probe: LocalBackendProbe } => {
        const listsModel = inventoryListsModel(health.modelsLoaded, model);
        const probe: LocalBackendProbe = {
          type,
          url: safeBaseUrl(backend),
          running: health.running,
          healthy: health.healthy,
          listsModel,
          error: health.error,
          probedMsAgo: Math.max(0, now - probedAt),
        };
        if (!health.running || !health.healthy || !listsModel) {
          return { candidate: null, probe };
        }
        if (inventoryListsModel(health.unservableModels, model)) {
          this.logger.debug(`[PoolProxy] local ${type} lists "${model}" but has been unable to serve it; not offering it as a candidate`);
          return {
            candidate: null,
            probe: { ...probe, error: probe.error ?? 'lists the model but has been unable to serve it; withheld until that observation decays' },
          };
        }
        return { candidate: { peerId: null, nodeFqdn: null, backend: type }, probe };
      },
    );
    return {
      candidates: results.map((entry) => entry.candidate).filter((c): c is PoolCandidate => c !== null),
      probes: results.map((entry) => entry.probe),
    };
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
        const inFlight = this.peerLoad(peer, capabilities);
        candidates.push({
          candidate: { peerId: peer.id, nodeFqdn: peer.nodeFqdn, backend: match.type },
          score: inFlight + weight * pressure + this.localAffinity(),
          inFlight,
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
   * A peer's queue depth, from the two vantage points we have on it: what we have forwarded to it and
   * not finished reading back, counted live, plus what its last health poll reported beyond our own
   * forwards of that moment — work from its apps and from other nodes, which only the snapshot sees.
   *
   * Not the larger of our counter and the report. The report counts our forwards too, and is up to a
   * poll interval old, so a node that served us a request seconds ago read as busy until the next
   * poll, long after that request had finished. Placement treats queue depth as a hard key, so the
   * nodes in use looked busier than an idle slow one. Fleet retest, 2026-10-01: a 37,571-token turn
   * went to core-7 (187 s predicted) while beta-1 (6 s) had finished its last request two seconds
   * before, and was still reported as having one.
   */
  private peerLoad(peer: HubPoolPeer, capabilities: PoolPeerCapabilities): number {
    const forwarded = this.loadService.get(peer.id);
    const reported = this.reportedPeerLoad(peer, capabilities);
    // A figure we cannot read is a floor, not a count to take our own forwards out of.
    return reported === null ? Math.max(forwarded, UNKNOWN_PEER_LOAD) : forwarded + this.loadService.externalLoad(peer.id, reported);
  }

  /** Self-reported queue depth, or `null` when the snapshot is stale or carries no figure. */
  private reportedPeerLoad(peer: HubPoolPeer, capabilities: PoolPeerCapabilities): number | null {
    // Freshness comes from the shared helper so that load and pressure — two fields of one snapshot
    // — can never drift apart on what "stale" means. It is judged on lastSeenAt, stamped by OUR
    // clock when the probe succeeded, not on capabilities.updatedAt, which is the peer's.
    if (!this.isSnapshotFresh(peer)) {
      return null;
    }
    return capabilities.inFlightRequests ?? null;
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
    payload: string | undefined = forwardedPayload(method, body),
    clientClosed?: AbortSignal,
  ): Promise<globalThis.Response> {
    const backendImpl = this.backends.get(backend);
    const url = `${backendImpl.getBaseUrl()}${path}`;
    const apiKey = backendImpl.getApiKey?.();
    return this.fetchWithConnectTimeout(
      url,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: payload,
      },
      isStreamingRequest(body, path),
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
    payload: string | undefined = forwardedPayload(method, body),
    requestId?: string,
    clientClosed?: AbortSignal,
  ): Promise<globalThis.Response> {
    if (candidate.peerId === null) {
      // The Hub's residency arbitration has already run for a generation, in the routed walk, which
      // is the only caller that sends one here: see `arbitrateLocalLoad`.
      return this.callBackend(candidate.backend, path, method, body, payload, clientClosed);
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
    const peerPayload = payload;
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
          // So the peer's inbound row carries the id this Hub's outbound row has. Outside the signed
          // material, like the two headers above: it labels a log row and authorises nothing.
          ...(requestId ? { [POOL_REQUEST_ID_HEADER]: requestId } : {}),
          ...authHeaders,
        },
        body: peerPayload,
      },
      isStreamingRequest(body, path),
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
    const budget = forwardBudgetMs(streaming, bodyBytes);
    const timer = setTimeout(
      () =>
        controller.abort(
          new PoolForwardDeadlineError(streaming ? `No response headers within ${budget}ms` : `No completion within ${budget}ms`, budget),
        ),
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
   * `attribution` is the routed path's serving-node statement (see {@link servedByHeaders}), or on a
   * peer's inbound relay the engine that answered (see {@link isRelayedEngineResponse}). It is
   * set here, and nowhere later, because Node flushes headers on the first body write: anything
   * set after `streamResponse` starts would be ERR_HTTP_HEADERS_SENT on a streamed completion.
   * Upstream `x-hub-pool-*` headers are dropped whether or not there is an attribution to replace
   * them — see {@link POOL_HEADER_PREFIX}.
   *
   * `status` is the upstream's own unless the routed path relays an engine's refusal of the request
   * under another (see {@link relayedRequestErrorStatus}); the body goes through untouched either way.
   */
  private commitResponse(upstream: globalThis.Response, res: Response, attribution?: Record<string, string>, status = upstream.status): void {
    res.status(status);
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
   * Relay the body to the caller. Everything in `taps` is optional and reads the body on the way past
   * without changing a byte: `onUsage` and `observer` a token-usage frame and engine timings (see
   * `response-usage-tap.ts`), `judge` whether the answer finished and said anything (see
   * `hub-pool-output-check.ts`). `body` replaces the upstream's own when the caller has already read
   * it — a non-streamed completion held to be judged.
   *
   * Through `relayToResponse`, not `pipeline`: the relay hears the response close through the request's
   * one watch, where `pipeline` added seven `close` listeners of its own — see `watchResponseClose`.
   */
  private async streamResponse(
    upstream: globalThis.Response,
    res: Response,
    watch: ResponseCloseWatch,
    taps: {
      onUsage?: (usage: PoolRoutingUsage) => void;
      observer?: ResponseTapObserver;
      judge?: OutputJudge | null;
      body?: WebReadableStream<Uint8Array>;
    } = {},
  ): Promise<void> {
    const source = taps.body ?? (upstream.body as WebReadableStream<Uint8Array> | null);
    if (!source) {
      res.end();
      return;
    }
    let body = source;
    if (taps.onUsage || taps.observer) {
      body = tapResponseUsageWhileStreaming(body, taps.onUsage ?? (() => undefined), taps.observer);
    }
    if (taps.judge) {
      body = taps.judge.tap(body);
    }
    await relayToResponse(body as unknown as ReadableStream<Uint8Array>, res, watch);
  }
}
