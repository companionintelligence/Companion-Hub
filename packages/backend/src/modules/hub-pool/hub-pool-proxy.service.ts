import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Response } from 'express';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  CAPABILITIES_FRESHNESS_POLLS,
  UNKNOWN_PRESSURE,
  effectivePeerPressureBand,
  inventoryListsModel,
  isCapabilitiesSnapshotFresh,
  resolveHubPoolDirections,
  resolvePinFor,
  type HubPoolDirectionalState,
  type HubPoolPin,
} from '@/common/helpers/hub-pool';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from './hub-pool-load.service';
import { HubPoolRoutingLogService, type PoolRoutingOutcome, type PoolRoutingPin } from './hub-pool-routing-log.service';
import { HubPoolPressureService } from './hub-pool-pressure.service';
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
  const timedOut = /No (?:response headers|completion) within \d+ms/.test(message) || /abort/i.test(message);
  const plural = candidates === 1 ? 'candidate' : 'candidates';
  if (timedOut) {
    return (
      `No pool candidate answered for model "${model}" within its deadline ` +
      `(${candidates} ${plural} tried; ${CONNECT_TIMEOUT_MS}ms for headers on a streamed request, ` +
      `${COMPLETION_TIMEOUT_MS}ms for a whole non-streamed completion). This is a deadline, not ` +
      'proof the nodes are down — a node loading weights or serving a long queue hits it while ' +
      'remaining healthy. Retry, or raise HUB_POOL_FIRST_BYTE_TIMEOUT_MS / HUB_POOL_COMPLETION_TIMEOUT_MS.'
    );
  }
  return `All ${candidates} pool ${plural} for model "${model}" failed${message ? `: ${message}` : '.'}`;
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
 * `ci-hub/auto`, which is how it surfaced.
 */
export const AUTO_MODEL = 'auto';

/** What an `auto` request is told when this Hub has nothing to stand it in for. */
export function describeUnresolvableAuto(): string {
  return `No default model is available to stand in for "${AUTO_MODEL}": pin or load an LLM on this Hub, or ask for a model by name.`;
}

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
    // the `auto` resolution below is the only thing that needs the local model registry.
    @Optional() @Inject(forwardRef(() => InferenceRouterService)) private readonly router?: InferenceRouterService,
    @Optional() @Inject(forwardRef(() => ModelRegistryService)) private readonly modelRegistry?: ModelRegistryService,
  ) {}

  /**
   * `auto` → the engine id of this Hub's default LLM; any other model unchanged.
   *
   * Same answer the peerless path gives (`resolveAutoModel`: the pinned LLM, else a loaded one,
   * else the first model a healthy backend reports), then mapped from catalog id to the id the
   * engine inventory actually lists — `qwen3-6-27b` is what the registry pins, `qwen3.6:27b` is
   * what every node's `modelsLoaded` says, and candidate matching reads the latter verbatim.
   * Resolved on THIS node deliberately: "auto" means this operator's default, and a peer that
   * also has that model is then a legitimate candidate for it like any other.
   */
  async resolveModelAlias(model: string): Promise<string | undefined> {
    if (model !== AUTO_MODEL) {
      return model;
    }
    if (!this.router) {
      return undefined;
    }
    const resolved = await this.router.resolveAutoModel();
    if (!resolved) {
      return undefined;
    }
    return this.modelRegistry?.getTrackedModel(resolved)?.backendModelId ?? resolved;
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
   * An operator pin is applied LAST, to the finished list — see {@link applyPin}. It reorders; it
   * cannot admit a node the steps above excluded.
   */
  async buildCandidateList(model: string): Promise<PoolCandidate[]> {
    return (await this.rankCandidates(model)).candidates;
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
  private async rankCandidates(model: string): Promise<{ candidates: PoolCandidate[]; pin: HubPoolPin | null }> {
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
    // Read from the same in-memory settings object every other pool knob comes from, so a pin takes
    // effect on the next request and costs no query on the inference hot path.
    const pin = resolvePinFor(this.configuration.getHubPoolPreferences().poolPins, model);
    return { candidates: applyPin(ordered, pin), pin };
  }

  async proxyRequest(params: { path: string; method: string; body: unknown; model: string; res: Response }): Promise<void> {
    const { path, method, res } = params;
    const startedAt = Date.now();
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
        outcome: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
      });
      res.status(502).json({ error: describeUnresolvableAuto() });
      return;
    }
    // The engine gets the resolved id, never the alias: it is the pool that knows what `auto` means
    // here, and a peer's engine would refuse the literal word.
    const body = model === params.model || !isRecord(params.body) ? params.body : { ...params.body, model };
    const { candidates, pin } = await this.rankCandidates(model);
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
        outcome: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
      });
      res.status(502).json({ error: describeNoCandidates(model, pin) });
      return;
    }

    let lastError: unknown;
    let committed = false;
    for (const [index, candidate] of candidates.entries()) {
      const key = candidate.peerId ?? LOCAL_CANDIDATE_KEY;
      const nodeLabel = candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY;
      this.loadService.acquire(key);
      try {
        const upstream = await this.forward(candidate, path, method, body, model);
        // Before the failover branch, so both outcomes teach the local engine the same thing: a
        // live request is the only place the pool ever learns whether a model actually serves.
        this.noteLocalServing(candidate, model, upstream.status);
        if (this.shouldFailover(candidate, upstream.status)) {
          lastError = new Error(`${candidate.nodeFqdn ?? 'local'} returned ${upstream.status}`);
          failedOverFrom.push(nodeLabel);
          await this.noteRejectedCandidate(candidate, upstream.status);
          continue;
        }
        // Recorded here rather than after the stream: this is the routing decision, and a
        // generation that runs for minutes would otherwise be invisible to the operator until
        // it finished (or never, if the client hung up).
        this.routingLog.record({
          at: new Date().toISOString(),
          direction: 'outbound',
          path,
          model,
          node: nodeLabel,
          peerId: candidate.peerId,
          backend: candidate.backend,
          candidates: candidates.length,
          attempt: index + 1,
          failedOverFrom: [...failedOverFrom],
          pin: describePinForLog(pin),
          outcome: 'served',
          status: upstream.status,
          durationMs: Date.now() - startedAt,
        });
        // Attribution rides on the commit, so it is on the wire before the first body byte on the
        // streamed path too — the headers are the point of no return, the body follows.
        this.commitResponse(upstream, res, servedByHeaders(candidate, model));
        committed = true;
        await this.streamResponse(upstream, res);
        return;
      } catch (error) {
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

    this.routingLog.record({
      at: new Date().toISOString(),
      direction: 'outbound',
      path,
      model,
      node: null,
      peerId: null,
      backend: null,
      candidates: candidates.length,
      attempt: candidates.length,
      failedOverFrom: [...failedOverFrom],
      pin: describePinForLog(pin),
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
    this.loadService.acquire(LOCAL_CANDIDATE_KEY);
    // Recorded once per forward, whichever way it ends: a stream that dies after the backend
    // answered is the same routing decision, not a second one.
    let recorded = false;
    try {
      const upstream = await this.callBackend(backend, path, method, body);
      // Logged from the receiving side too, so an operator can answer "which of my peers is
      // spending my GPU time" — the sender's own log only covers what it sent.
      this.recordInbound(backend, path, fromPeerFqdn, upstream.status, startedAt);
      recorded = true;
      // A peer's forward is the only evidence an inbound-only node ever gets that one of its own
      // models cannot run: nothing here goes through `proxyRequest`, so without this the node
      // earns no strikes, withholds nothing, and keeps advertising the dead model to its peers.
      this.noteLocalServingOutcome(backend, model, upstream.status);
      await this.pipeResponse(upstream, res);
    } catch (error) {
      if (!recorded) {
        this.recordInbound(backend, path, fromPeerFqdn, null, startedAt);
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
      outcome: outcome ?? (status !== null && status < 500 ? 'served' : 'failed'),
      status,
      durationMs: Date.now() - startedAt,
    });
  }

  /**
   * Best-effort passthrough for the endpoints that carry no `model` field and so can't be routed
   * across the pool — `GET /v1/models`, `GET /api/tags`, `GET /api/ps`, `GET /api/version`,
   * `POST /api/show`. Tries this node's own backends in order and serves the first that answers.
   * Cross-node merging of the listing endpoints is a known gap; see docs/hub-pool.md.
   */
  async proxyLocalOnlyRequest(path: string, method: string, body: unknown, res: Response): Promise<void> {
    // Ollama's `/api/show` names the model in `name` (older clients) or `model`, and an app whose
    // chat model is the `auto` alias asks about `auto` here before its first chat — OpenClaw's
    // provider does exactly that, and read the engine's 404 as "model not found" without ever
    // sending the chat. The alias means this node's default, so it resolves here the same way.
    const resolvedBody = await this.resolveLocalOnlyAlias(body);
    if (resolvedBody === null) {
      this.respondUncommitted(res, 502, { error: describeUnresolvableAuto() });
      return;
    }
    let committed = false;
    for (const type of INFERENCE_BACKEND_TYPES) {
      try {
        const upstream = await this.callBackend(type, path, method, resolvedBody);
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
        if (committed) {
          res.destroy();
          return;
        }
      }
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

  private async callBackend(backend: InferenceBackendType, path: string, method: string, body: unknown): Promise<globalThis.Response> {
    const backendImpl = this.backends.get(backend);
    const url = `${backendImpl.getBaseUrl()}${path}`;
    const apiKey = backendImpl.getApiKey?.();
    return this.fetchWithConnectTimeout(
      url,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body),
      },
      isStreamingRequest(body),
    );
  }

  private async forward(candidate: PoolCandidate, path: string, method: string, body: unknown, model: string): Promise<globalThis.Response> {
    if (candidate.peerId === null) {
      return this.callBackend(candidate.backend, path, method, body);
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
        body: method === 'GET' ? undefined : JSON.stringify(body),
      },
      isStreamingRequest(body),
    );
  }

  /**
   * `fetch` with a deadline sized to what we are actually waiting for.
   *
   * Streamed: headers arrive almost immediately, so the short connect budget is the right guard and
   * the timer is cleared before the body flows — a long generation is never cut off mid-stream.
   * Non-streamed: headers arrive only when the completion is finished, so the wait we are timing IS
   * the generation, and the budget has to be sized for one. See COMPLETION_TIMEOUT_MS.
   */
  private async fetchWithConnectTimeout(url: string, init: RequestInit, streaming = false): Promise<globalThis.Response> {
    const controller = new AbortController();
    const budget = streaming ? CONNECT_TIMEOUT_MS : COMPLETION_TIMEOUT_MS;
    const timer = setTimeout(
      () => controller.abort(new Error(streaming ? `No response headers within ${budget}ms` : `No completion within ${budget}ms`)),
      budget,
    );
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
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

  private async streamResponse(upstream: globalThis.Response, res: Response): Promise<void> {
    if (!upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as WebReadableStream), res);
  }

  private async pipeResponse(upstream: globalThis.Response, res: Response): Promise<void> {
    this.commitResponse(upstream, res);
    await this.streamResponse(upstream, res);
  }
}
