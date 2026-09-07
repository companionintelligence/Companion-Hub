import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { ConfigurationService } from '@/core/config/configuration.service';
import { CAPABILITIES_FRESHNESS_POLLS, resolveHubPoolDirections, type HubPoolDirectionalState } from '@/common/helpers/hub-pool';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from './hub-pool-load.service';
import { HubPoolRoutingLogService, type PoolRoutingOutcome } from './hub-pool-routing-log.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { PoolCandidate, PoolPeerCapabilities } from './hub-pool.types';

/** Header-wait timeout for a forwarded request. Cleared as soon as the upstream responds, so it never caps how long a streamed generation may run. */
const CONNECT_TIMEOUT_MS = 15_000;
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade']);
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

/** A candidate plus the two ordering keys {@link PoolProxyService.buildCandidateList} sorts on. */
interface RankedCandidate {
  candidate: PoolCandidate;
  /** Queue depth, already carrying the local-affinity handicap for peers. Lower is better. */
  score: number;
  tierRank: number;
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
  ) {}

  /** Read per request, not cached: a settings PATCH must change routing on the next request, not on the next restart. */
  private localAffinity(): number {
    return this.configuration.getHubPoolPreferences().poolLocalAffinity;
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
   */
  async buildCandidateList(model: string): Promise<PoolCandidate[]> {
    const [local, peers] = await Promise.all([this.localCandidates(model), this.usablePeers()]);
    const localScore = this.loadService.localInFlight();
    const ranked: RankedCandidate[] = [
      ...local.map((candidate) => ({ candidate, score: localScore, tierRank: LOCAL_TIER_RANK })),
      ...this.peerCandidates(model, peers),
    ];
    // Stable sort: candidates that tie on both keys keep insertion order — local backends in
    // INFERENCE_BACKEND_TYPES order, then peers in the order the repository returned them.
    return ranked.sort((a, b) => a.score - b.score || a.tierRank - b.tierRank).map((entry) => entry.candidate);
  }

  async proxyRequest(params: { path: string; method: string; body: unknown; model: string; res: Response }): Promise<void> {
    const { path, method, body, model, res } = params;
    const startedAt = Date.now();
    const candidates = await this.buildCandidateList(model);
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
        outcome: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
      });
      res.status(502).json({ error: `No pool node currently has model "${model}" available.` });
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
          outcome: 'served',
          status: upstream.status,
          durationMs: Date.now() - startedAt,
        });
        this.commitResponse(upstream, res);
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
      outcome: 'failed',
      status: null,
      durationMs: Date.now() - startedAt,
    });
    this.logger.error(
      `[PoolProxy] all ${candidates.length} candidate(s) for model "${model}" failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    this.respondUncommitted(res, 502, { error: `All pool nodes serving model "${model}" are currently unreachable.` });
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
    let committed = false;
    for (const type of INFERENCE_BACKEND_TYPES) {
      try {
        const upstream = await this.callBackend(type, path, method, body);
        if (!upstream.ok) {
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
    this.respondUncommitted(res, 502, { error: `No local backend able to serve ${path}` });
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
          if (!health.running || !health.healthy || !health.modelsLoaded.includes(model)) {
            return null;
          }
          if (health.unservableModels?.includes(model)) {
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

  private peerCandidates(model: string, peers: HubPoolPeer[]): RankedCandidate[] {
    const candidates: RankedCandidate[] = [];
    for (const peer of peers) {
      const capabilities = peer.lastCapabilities as unknown as PoolPeerCapabilities | null;
      if (!capabilities) continue;
      // Skipped on the flag itself, not on an empty inventory: a peer that has switched inbound off
      // (or disabled us) is a healthy machine we keep polling successfully, and an empty `backends`
      // is pixel-identical to one whose engines are simply down. `undefined` means a peer on an
      // older build, which never refuses, so absence must read as "yes".
      if (capabilities.acceptingWork === false) continue;
      const match = capabilities.backends.find((b) => b.healthy && b.modelsLoaded.includes(model));
      if (match) {
        candidates.push({
          candidate: { peerId: peer.id, nodeFqdn: peer.nodeFqdn, backend: match.type },
          score: this.peerLoad(peer, capabilities) + this.localAffinity(),
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
    // Freshness is judged on lastSeenAt, stamped by OUR clock when the probe succeeded, not on
    // capabilities.updatedAt, which is the peer's — comparing another machine's clock to ours would
    // read skew as staleness (or, worse, staleness as freshness).
    const observedAt = peer.lastSeenAt ? Date.parse(peer.lastSeenAt) : Number.NaN;
    if (!Number.isFinite(observedAt) || Date.now() - observedAt > this.capabilitiesFreshnessMs()) {
      return UNKNOWN_PEER_LOAD;
    }
    return capabilities.inFlightRequests ?? UNKNOWN_PEER_LOAD;
  }

  private async callBackend(backend: InferenceBackendType, path: string, method: string, body: unknown): Promise<globalThis.Response> {
    const backendImpl = this.backends.get(backend);
    const url = `${backendImpl.getBaseUrl()}${path}`;
    const apiKey = backendImpl.getApiKey?.();
    return this.fetchWithConnectTimeout(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
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
    return this.fetchWithConnectTimeout(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Tells the peer's `/inference/pool/local/*` handler which of ITS OWN backends to hit —
        // it can't infer this from the path alone, and must not re-run candidate selection itself.
        'X-Hub-Pool-Backend': candidate.backend,
        // Lets the receiver credit the outcome to the right model without parsing the body it
        // promises not to read. Same reason as the header above: the path alone doesn't carry it.
        'X-Hub-Pool-Model': model,
        ...authHeaders,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  }

  /** `fetch` with a timeout that only guards the wait for response headers — cleared immediately once they arrive, so a long streamed generation is never cut off mid-stream. */
  private async fetchWithConnectTimeout(url: string, init: RequestInit): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`No response headers within ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
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
   */
  private commitResponse(upstream: globalThis.Response, res: Response): void {
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
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
