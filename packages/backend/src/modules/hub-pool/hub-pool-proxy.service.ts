import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { MtplxBackend } from '@/modules/inference/backends/mtplx.backend';
import { DsparkBackend } from '@/modules/inference/backends/dspark.backend';
import { LuceboxBackend } from '@/modules/inference/backends/lucebox.backend';
import type { InferenceBackend } from '@/modules/inference/backends/backend.interface';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from './hub-pool-load.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { PoolCandidate, PoolPeerCapabilities } from './hub-pool.types';

export const ALL_BACKEND_TYPES: InferenceBackendType[] = ['ollama', 'vllm', 'lemonade', 'mtplx', 'dspark', 'lucebox'];
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
 * The head start the local node gets over a peer, in queued requests.
 *
 * This is a real advantage, not favouritism: a follow-up turn served here reuses the prompt prefix
 * and KV cache the previous turn left resident, while the same turn sent to a peer re-processes the
 * whole prompt cold. One queued request is roughly what that re-processing costs, so work only
 * leaves this node once a peer is at least that much emptier. Tuning it to 0 makes the pool a pure
 * least-loaded balancer; raising it makes handoff rarer.
 */
const LOCAL_AFFINITY_REQUESTS = 1;

/**
 * How old a peer's capability snapshot may be before its self-reported load is discarded. Three
 * health polls (`HEALTH_POLL_INTERVAL_MS` in hub-pool-peer.service.ts is 30s), matching the three
 * strikes that mark a peer unreachable — a peer still `connected` but two polls behind is exactly
 * the case this covers.
 */
const CAPABILITIES_FRESHNESS_MS = 90_000;

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
 * The local node is never out-ranked on hardware: local-vs-peer is decided entirely by
 * {@link LOCAL_AFFINITY_REQUESTS}, and reading this node's own tier would put a hardware probe on
 * the request path for a value that only breaks ties.
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
 * The local node's head start is the explicit {@link LOCAL_AFFINITY_REQUESTS}
 * constant, not an accident of list order.
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
    private readonly ollamaBackend: OllamaBackend,
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
    private readonly mtplxBackend: MtplxBackend,
    private readonly dsparkBackend: DsparkBackend,
    private readonly luceboxBackend: LuceboxBackend,
    private readonly peerService: HubPoolPeerService,
    private readonly tailscaleService: TailscaleService,
    private readonly loadService: HubPoolLoadService,
  ) {}

  private getBackend(type: InferenceBackendType): InferenceBackend {
    switch (type) {
      case 'ollama':
        return this.ollamaBackend;
      case 'vllm':
        return this.vllmBackend;
      case 'lemonade':
        return this.lemonadeBackend;
      case 'mtplx':
        return this.mtplxBackend;
      case 'dspark':
        return this.dsparkBackend;
      case 'lucebox':
        return this.luceboxBackend;
    }
  }

  /**
   * Every node that can serve `model`, best first.
   *
   * Local and peer candidates are ranked together. Concatenating them instead — the shape this
   * replaced — made the pool a failover list rather than a balancer: a local backend that merely
   * *had* the model always sorted first, whatever its queue looked like, so the one scenario
   * pooling exists for (this node saturated, a peer idle) could never route away.
   */
  async buildCandidateList(model: string): Promise<PoolCandidate[]> {
    const [local, peers] = await Promise.all([this.localCandidates(model), this.peerService.listConnectedPeers()]);
    const localScore = this.loadService.localInFlight();
    const ranked: RankedCandidate[] = [
      ...local.map((candidate) => ({ candidate, score: localScore, tierRank: LOCAL_TIER_RANK })),
      ...this.peerCandidates(model, peers),
    ];
    // Stable sort: candidates that tie on both keys keep insertion order — local backends in
    // ALL_BACKEND_TYPES order, then peers in the order the repository returned them.
    return ranked.sort((a, b) => a.score - b.score || a.tierRank - b.tierRank).map((entry) => entry.candidate);
  }

  async proxyRequest(params: { path: string; method: string; body: unknown; model: string; res: Response }): Promise<void> {
    const { path, method, body, model, res } = params;
    const candidates = await this.buildCandidateList(model);

    if (candidates.length === 0) {
      res.status(502).json({ error: `No pool node currently has model "${model}" available.` });
      return;
    }

    let lastError: unknown;
    let committed = false;
    for (const candidate of candidates) {
      const key = candidate.peerId ?? LOCAL_CANDIDATE_KEY;
      this.loadService.acquire(key);
      try {
        const upstream = await this.forward(candidate, path, method, body);
        if (this.shouldFailover(candidate, upstream.status)) {
          lastError = new Error(`${candidate.nodeFqdn ?? 'local'} returned ${upstream.status}`);
          await this.noteRejectedCandidate(candidate, upstream.status);
          continue;
        }
        this.commitResponse(upstream, res);
        committed = true;
        await this.streamResponse(upstream, res);
        return;
      } catch (error) {
        lastError = error;
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
  async forwardToLocalBackendAndRespond(backend: InferenceBackendType, path: string, method: string, body: unknown, res: Response): Promise<void> {
    // Counted like a locally-routed request: a peer's forwarded work occupies this node's engine
    // exactly as its own apps' does, and a node busy serving the pool must not report itself idle
    // to the very peers deciding whether to send it more.
    this.loadService.acquire(LOCAL_CANDIDATE_KEY);
    try {
      const upstream = await this.callBackend(backend, path, method, body);
      await this.pipeResponse(upstream, res);
    } finally {
      this.loadService.release(LOCAL_CANDIDATE_KEY);
    }
  }

  /**
   * Best-effort passthrough for the endpoints that carry no `model` field and so can't be routed
   * across the pool — `GET /v1/models`, `GET /api/tags`, `GET /api/ps`, `GET /api/version`,
   * `POST /api/show`. Tries this node's own backends in order and serves the first that answers.
   * Cross-node merging of the listing endpoints is a known gap; see docs/hub-pool.md.
   */
  async proxyLocalOnlyRequest(path: string, method: string, body: unknown, res: Response): Promise<void> {
    let committed = false;
    for (const type of ALL_BACKEND_TYPES) {
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

  private async localCandidates(model: string): Promise<PoolCandidate[]> {
    const results = await Promise.all(
      ALL_BACKEND_TYPES.map(async (type): Promise<PoolCandidate | null> => {
        try {
          const health = await this.getBackend(type).healthCheck();
          if (health.running && health.healthy && health.modelsLoaded.includes(model)) {
            return { peerId: null, nodeFqdn: null, backend: type };
          }
        } catch (error) {
          this.logger.debug(`[PoolProxy] local ${type} health check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      }),
    );
    return results.filter((c): c is PoolCandidate => c !== null);
  }

  private peerCandidates(model: string, peers: HubPoolPeer[]): RankedCandidate[] {
    const candidates: RankedCandidate[] = [];
    for (const peer of peers) {
      const capabilities = peer.lastCapabilities as unknown as PoolPeerCapabilities | null;
      if (!capabilities) continue;
      const match = capabilities.backends.find((b) => b.healthy && b.modelsLoaded.includes(model));
      if (match) {
        candidates.push({
          candidate: { peerId: peer.id, nodeFqdn: peer.nodeFqdn, backend: match.type },
          score: this.peerLoad(peer, capabilities) + LOCAL_AFFINITY_REQUESTS,
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
    if (!Number.isFinite(observedAt) || Date.now() - observedAt > CAPABILITIES_FRESHNESS_MS) {
      return UNKNOWN_PEER_LOAD;
    }
    return capabilities.inFlightRequests ?? UNKNOWN_PEER_LOAD;
  }

  private async callBackend(backend: InferenceBackendType, path: string, method: string, body: unknown): Promise<globalThis.Response> {
    const backendImpl = this.getBackend(backend);
    const url = `${backendImpl.getBaseUrl()}${path}`;
    const apiKey = backendImpl.getApiKey?.();
    return this.fetchWithConnectTimeout(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  }

  private async forward(candidate: PoolCandidate, path: string, method: string, body: unknown): Promise<globalThis.Response> {
    if (candidate.peerId === null) {
      return this.callBackend(candidate.backend, path, method, body);
    }

    const peer = await this.peerService.getPeerById(candidate.peerId);
    if (!peer) {
      throw new Error(`Peer ${candidate.peerId} is no longer paired`);
    }
    const [token, selfStatus] = await Promise.all([this.peerService.getPresentToken(peer), this.tailscaleService.getStatusCached()]);
    const url = `https://${peer.nodeFqdn}/api/inference/pool/local${path}`;
    return this.fetchWithConnectTimeout(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Pool-Peer': selfStatus.nodeFqdn ?? '',
        // Tells the peer's `/inference/pool/local/*` handler which of ITS OWN backends to hit —
        // it can't infer this from the path alone, and must not re-run candidate selection itself.
        'X-Hub-Pool-Backend': candidate.backend,
        Authorization: `Bearer ${token}`,
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
