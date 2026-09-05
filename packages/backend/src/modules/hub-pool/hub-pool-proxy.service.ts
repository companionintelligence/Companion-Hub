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
 * Routes an app-facing inference request to whichever pool node (this one or a
 * connected peer) currently has the requested model, with failover.
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
  /** In-flight proxied-request count per candidate ('local' for this node, else peer id) — used only for ranking, not a hard limit. */
  private readonly inFlightByCandidate = new Map<string, number>();

  constructor(
    private readonly ollamaBackend: OllamaBackend,
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
    private readonly mtplxBackend: MtplxBackend,
    private readonly dsparkBackend: DsparkBackend,
    private readonly luceboxBackend: LuceboxBackend,
    private readonly peerService: HubPoolPeerService,
    private readonly tailscaleService: TailscaleService,
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

  async buildCandidateList(model: string): Promise<PoolCandidate[]> {
    const [local, peers] = await Promise.all([this.localCandidates(model), this.peerService.listConnectedPeers()]);
    return [...local, ...this.peerCandidates(model, peers)];
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
      const key = candidate.peerId ?? 'local';
      this.inFlightByCandidate.set(key, (this.inFlightByCandidate.get(key) ?? 0) + 1);
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
        this.inFlightByCandidate.set(key, Math.max(0, (this.inFlightByCandidate.get(key) ?? 1) - 1));
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
    const upstream = await this.callBackend(backend, path, method, body);
    await this.pipeResponse(upstream, res);
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

  private peerCandidates(model: string, peers: HubPoolPeer[]): PoolCandidate[] {
    const candidates: PoolCandidate[] = [];
    for (const peer of peers) {
      const capabilities = peer.lastCapabilities as unknown as PoolPeerCapabilities | null;
      if (!capabilities) continue;
      const match = capabilities.backends.find((b) => b.healthy && b.modelsLoaded.includes(model));
      if (match) {
        candidates.push({ peerId: peer.id, nodeFqdn: peer.nodeFqdn, backend: match.type });
      }
    }
    return candidates.sort((a, b) => this.load(a) - this.load(b));
  }

  private load(candidate: PoolCandidate): number {
    return this.inFlightByCandidate.get(candidate.peerId ?? 'local') ?? 0;
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
