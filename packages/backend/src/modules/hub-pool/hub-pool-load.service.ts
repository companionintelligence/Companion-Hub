import { Injectable } from '@nestjs/common';

/** Load-map key for this node. Peers are keyed by their `hub_pool_peer.id`. */
export const LOCAL_CANDIDATE_KEY = 'local';

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

  acquire(key: string): void {
    this.inFlight.set(key, this.get(key) + 1);
  }

  release(key: string): void {
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
}
