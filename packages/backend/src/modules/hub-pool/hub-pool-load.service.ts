import { Injectable } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { canonicalModelId } from '@/common/helpers/hub-pool';

/** Load-map key for this node. Peers are keyed by their `hub_pool_peer.id`. */
export const LOCAL_CANDIDATE_KEY = 'local';

/** A generation (chat or completion) one of this node's own engines is running, and the model it asked for. */
export interface LocalGeneration {
  backend: InferenceBackendType;
  model: string;
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
   * The local generations among that work, per engine and model. Queue depth says how much an
   * engine is doing; this says what, which is what a request for a model the engine does not hold
   * has to know — Ollama may not load it until another model's turn lets go (see
   * `applyLocalContention`).
   */
  private readonly generations = new Map<InferenceBackendType, Map<string, number>>();

  /** `generation` is recorded only under {@link LOCAL_CANDIDATE_KEY}: a peer's engines are its own to report. */
  acquire(key: string, generation?: LocalGeneration): void {
    this.inFlight.set(key, this.get(key) + 1);
    if (generation && key === LOCAL_CANDIDATE_KEY) {
      const models = this.generations.get(generation.backend) ?? new Map<string, number>();
      const model = canonicalModelId(generation.model);
      models.set(model, (models.get(model) ?? 0) + 1);
      this.generations.set(generation.backend, models);
    }
  }

  /** Takes the same `generation` its `acquire` did. */
  release(key: string, generation?: LocalGeneration): void {
    if (generation && key === LOCAL_CANDIDATE_KEY) {
      const models = this.generations.get(generation.backend);
      const model = canonicalModelId(generation.model);
      const left = (models?.get(model) ?? 0) - 1;
      if (left > 0) {
        models?.set(model, left);
      } else {
        models?.delete(model);
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

  /** The models `backend` has generations in flight for right now, one canonical id each. */
  localGenerationsOn(backend: InferenceBackendType): string[] {
    return [...(this.generations.get(backend)?.keys() ?? [])];
  }
}
