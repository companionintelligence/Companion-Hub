import type { InferenceBackendType } from '@ci-hub/common/types';
import type { HubPoolPeer } from '@/core/database/drizzle/types';

/** One backend's live model availability on a node, as reported by `GET /inference/pool/capabilities`. */
export interface PoolPeerBackendCapability {
  type: InferenceBackendType;
  healthy: boolean;
  modelsLoaded: string[];
}

/** Body returned by `GET /inference/pool/capabilities` and cached as `hub_pool_peer.last_capabilities`. */
export interface PoolPeerCapabilities {
  hardwareTier: string;
  backends: PoolPeerBackendCapability[];
  updatedAt: string;
}

/** A candidate node the proxy can route a request to for a given model. */
export interface PoolCandidate {
  /** `null` for the local node; the peer's `hub_pool_peer.id` otherwise. */
  peerId: string | null;
  nodeFqdn: string | null;
  backend: InferenceBackendType;
}

/** Discoverable Tailscale device that identified itself as a CI-Hub node and isn't paired yet. */
export interface DiscoverablePoolPeer {
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
}

/**
 * `hub_pool_peer` shape safe to send to the operator UI — everything except the
 * token material (`verifyTokenHash`, `presentTokenEncrypted`). Neither value
 * should ever leave the backend process: the hash is only useful for local
 * verification, and the encrypted token exists solely so THIS Hub can decrypt
 * and present it on its own outbound calls.
 */
export type PublicHubPoolPeer = Omit<HubPoolPeer, 'verifyTokenHash' | 'presentTokenEncrypted'>;

export function toPublicPeer(peer: HubPoolPeer): PublicHubPoolPeer {
  const { verifyTokenHash: _verifyTokenHash, presentTokenEncrypted: _presentTokenEncrypted, ...publicFields } = peer;
  return publicFields;
}
