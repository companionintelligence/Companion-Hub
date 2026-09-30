import { Injectable } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { canonicalModelId } from '@/common/helpers/hub-pool';

/** Load-map key for this node. Peers are keyed by their `hub_pool_peer.id`. */
export const LOCAL_CANDIDATE_KEY = 'local';

/** A generation (chat or completion) one of this node's own engines is running, and the model and window it asked for. */
export interface LocalGeneration {
  backend: InferenceBackendType;
  model: string;
  /** Its `options.num_ctx`; `null` when it named none — every `/v1` request — so it runs at the engine's default. */
  numCtx: number | null;
}

/**
 * Work one of this node's engines is doing for a model that is not a generation: an embedding
 * batch. It holds the model's runner exactly as a turn does — Ollama will not unload it until the
 * batch ends — but it has no window and joins no queue of turns, so it is kept out of
 * {@link HubPoolLoadService.localGenerationsOn}, which the contention and throughput judgements read.
 */
export interface LocalModelWork {
  backend: InferenceBackendType;
  model: string;
}

/** One model at one window on one engine, and how many of its generations are in flight there. */
interface RunningGenerations {
  model: string;
  numCtx: number | null;
  count: number;
}

/**
 * In-flight inference request counts per pool candidate, used to rank them.
 *
 * Two different quantities share the map, by key: under {@link LOCAL_CANDIDATE_KEY} it is work
 * *this* node's engines are running right now (whether it arrived from a local app or was forwarded
 * by a peer); under a peer id it is work this node has forwarded to that peer and not yet finished
 * reading back.
 *
 * It lives in its own service because both {@link PoolProxyService} (which ranks with it) and
 * `HubPoolPeerService` (which publishes the local figure to peers in the capabilities blob) need
 * it, and the proxy already depends on the peer service — a field on either would close that cycle.
 *
 * Process-local and reset by a restart: a routing hint, never a limit or an accounting record.
 */
@Injectable()
export class HubPoolLoadService {
  private readonly inFlight = new Map<string, number>();
  /**
   * The local generations among that work, per engine, keyed by model and window. Queue depth says
   * how much an engine is doing; this says what, which is what the next request has to know when it
   * cannot join that work — another model's turn, which Ollama must load beside or evict behind, or
   * this model's at another window, which Ollama must reload for (see `applyLocalContention`).
   */
  private readonly generations = new Map<InferenceBackendType, Map<string, RunningGenerations>>();
  /** The local {@link LocalModelWork} among that work, per engine: canonical model id → requests in flight. */
  private readonly otherWork = new Map<InferenceBackendType, Map<string, number>>();

  /**
   * `generation` and `work` are recorded only under {@link LOCAL_CANDIDATE_KEY}: a peer's engines are
   * its own to report. A request passes one or the other, never both.
   */
  acquire(key: string, generation?: LocalGeneration, work?: LocalModelWork): void {
    this.inFlight.set(key, this.get(key) + 1);
    if (work && key === LOCAL_CANDIDATE_KEY) {
      const running = this.otherWork.get(work.backend) ?? new Map<string, number>();
      const model = canonicalModelId(work.model);
      running.set(model, (running.get(model) ?? 0) + 1);
      this.otherWork.set(work.backend, running);
    }
    if (generation && key === LOCAL_CANDIDATE_KEY) {
      const running = this.generations.get(generation.backend) ?? new Map<string, RunningGenerations>();
      const model = canonicalModelId(generation.model);
      const id = generationKey(model, generation.numCtx);
      const entry = running.get(id) ?? { model, numCtx: generation.numCtx, count: 0 };
      entry.count += 1;
      running.set(id, entry);
      this.generations.set(generation.backend, running);
    }
  }

  /** Takes the same `generation` and `work` its `acquire` did. */
  release(key: string, generation?: LocalGeneration, work?: LocalModelWork): void {
    if (work && key === LOCAL_CANDIDATE_KEY) {
      const running = this.otherWork.get(work.backend);
      const model = canonicalModelId(work.model);
      const count = running?.get(model) ?? 0;
      if (count > 1) running?.set(model, count - 1);
      else running?.delete(model);
    }
    if (generation && key === LOCAL_CANDIDATE_KEY) {
      const running = this.generations.get(generation.backend);
      const id = generationKey(canonicalModelId(generation.model), generation.numCtx);
      const entry = running?.get(id);
      if (entry && entry.count > 1) {
        entry.count -= 1;
      } else {
        running?.delete(id);
      }
    }
    const next = this.get(key) - 1;
    if (next <= 0) {
      // Drop the key rather than leaving a 0 behind, so an unpaired peer's entry doesn't outlive it.
      this.inFlight.delete(key);
      return;
    }
    this.inFlight.set(key, next);
  }

  get(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }

  /** Requests this node's own engines are serving — its apps' and its peers' alike. */
  localInFlight(): number {
    return this.get(LOCAL_CANDIDATE_KEY);
  }

  /** What `backend` has generations in flight for right now: one entry per canonical model id and window. */
  localGenerationsOn(backend: InferenceBackendType): { model: string; numCtx: number | null }[] {
    return [...(this.generations.get(backend)?.values() ?? [])].map(({ model, numCtx }) => ({ model, numCtx }));
  }

  /**
   * Every model `backend` is doing work for right now, generation or embedding, once each by
   * canonical id: what a load must not evict. An embedding batch is here and not in
   * {@link localGenerationsOn}; evicting the embedder mid-batch only made Memory's next batch reload
   * it cold, the same as a turn's model.
   */
  localBusyModelsOn(backend: InferenceBackendType): { model: string }[] {
    const models = new Set<string>([
      ...[...(this.generations.get(backend)?.values() ?? [])].map(({ model }) => model),
      ...(this.otherWork.get(backend)?.keys() ?? []),
    ]);
    return [...models].map((model) => ({ model }));
  }
}

/** NUL cannot appear in a model id, so no model and window pair can collide with another. */
function generationKey(model: string, numCtx: number | null): string {
  return `${model}\u0000${numCtx ?? ''}`;
}
