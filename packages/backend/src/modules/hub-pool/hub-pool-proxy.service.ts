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

/**
 * Routes an app-facing inference request to whichever pool node (this one or a
 * connected peer) currently has the requested model, with failover.
 *
 * Never fails over on an ordinary 4xx (bad request) — only on a connection
 * error, a header-wait timeout, or a 5xx from the candidate. Retrying a
 * malformed request on a different machine just wastes a hop.
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
    for (const candidate of candidates) {
      const key = candidate.peerId ?? 'local';
      this.inFlightByCandidate.set(key, (this.inFlightByCandidate.get(key) ?? 0) + 1);
      try {
        const upstream = await this.forward(candidate, path, method, body);
        if (upstream.status >= 500) {
          lastError = new Error(`${candidate.nodeFqdn ?? 'local'} returned ${upstream.status}`);
          continue;
        }
        await this.pipeResponse(upstream, res);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `[PoolProxy] candidate ${candidate.nodeFqdn ?? 'local'} (${candidate.backend}) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.inFlightByCandidate.set(key, Math.max(0, (this.inFlightByCandidate.get(key) ?? 1) - 1));
      }
    }

    this.logger.error(
      `[PoolProxy] all ${candidates.length} candidate(s) for model "${model}" failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    res.status(502).json({ error: `All pool nodes serving model "${model}" are currently unreachable.` });
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

  /** Best-effort listing proxy for `GET /v1/models` / `GET /api/tags` — tries this node's own backends only. Cross-node model-list merging is a known gap; see docs/hub-pool.md. */
  async proxyListRequest(path: string, res: Response): Promise<void> {
    for (const type of ALL_BACKEND_TYPES) {
      try {
        const upstream = await this.callBackend(type, path, 'GET', undefined);
        if (upstream.ok) {
          await this.pipeResponse(upstream, res);
          return;
        }
      } catch (error) {
        this.logger.debug(`[PoolProxy] listing via local ${type} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    res.status(502).json({ error: 'No local backend available to list models' });
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

  private async pipeResponse(upstream: globalThis.Response, res: Response): Promise<void> {
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as WebReadableStream), res);
  }
}
