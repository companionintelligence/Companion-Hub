import type { InferenceBackendType } from '@ci-hub/common/types';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { HubPoolDisabledBy, HubPoolPreferences } from '@/common/helpers/hub-pool';

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
  /**
   * Requests the node's own engines were serving when the snapshot was taken — the only load signal
   * the Hub can actually measure, since it has no live GPU-utilization telemetry anywhere (see
   * `HardwareInspectorService`, which reports a static hardware profile, not counters).
   *
   * Optional because a peer on a pre-pooling-rank build omits it, and because the field arrives over
   * the wire: an absent or stale value must read as "unknown", never as "idle".
   */
  inFlightRequests?: number;
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

/** A peer row plus what this node currently has in flight to it. Built from {@link toPublicPeer}, so the token columns cannot reach it. */
export interface PoolStatusPeer extends PublicHubPoolPeer {
  /** Requests this node has forwarded to the peer and not yet finished reading. A live gauge reset by a restart, never a total. */
  inFlightRequests: number;
}

export interface PoolStatusLocalNode {
  nodeFqdn: string | null;
  tailnet: string | null;
  tailscaleConnected: boolean;
  /** Requests this node's own engines are serving — its apps' and its peers' alike. */
  inFlightRequests: number;
  hardwareTier: string | null;
  backends: PoolPeerBackendCapability[];
  /** Why the local inventory is empty, when it is — a down backend must read differently from a node with no models. */
  capabilitiesError: string | null;
}

/**
 * Why pooling is or isn't routing right now. `disabled_by_env` and `disabled_by_setting` are kept
 * apart on purpose: the UI must be able to say "your .env overrides this" rather than showing a
 * toggle that appears to do nothing.
 */
export type PoolStatusReason = 'active' | 'no_peers' | 'disabled_by_env' | 'disabled_by_setting';

export interface PoolStatus {
  /** Effective kill-switch state (env override applied). Not the same as `settings.poolEnabled`. */
  enabled: boolean;
  disabledBy: HubPoolDisabledBy | null;
  reason: PoolStatusReason;
  /** Whether apps are actually being routed through the pool: enabled AND at least one connected peer. */
  routingActive: boolean;
  /** The persisted settings as stored, before the env override — what a settings form should render. */
  settings: HubPoolPreferences;
  /** Whether TAILSCALE_OAUTH_CLIENT_ID/SECRET are set, i.e. whether peer discovery can work at all. Never the credentials themselves. */
  tailscaleAdminApiConfigured: boolean;
  localNode: PoolStatusLocalNode;
  peers: PoolStatusPeer[];
  peerCounts: { total: number; connected: number; pending: number; unreachable: number };
}
