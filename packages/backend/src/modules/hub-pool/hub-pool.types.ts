import type { InferenceBackendType } from '@ci-hub/common/types';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { HubPoolDirectionalState, HubPoolDisabledBy, HubPoolPreferences } from '@/common/helpers/hub-pool';

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
  /**
   * Whether the answering node will actually take work from the caller right now.
   *
   * `false` is what inbound-off and a per-peer disable look like on the wire, and it is the flag
   * `peerCandidates` skips on — explicitly, rather than inferring it from `backends: []`, which is
   * pixel-identical to a node whose engines are simply down. Optional because a peer on an older
   * build omits it; absent must read as "yes", since that is what every pre-switch build meant.
   */
  acceptingWork?: boolean;
  /**
   * Reserved for the GPU-pressure load signal: a smoothed 0-3 band of real device busy-ness.
   * ABSENT means unmeasured, which ranks neutral — never idle. Nothing in this build sets it.
   */
  gpuPressure?: number;
  /** Reserved, alongside {@link gpuPressure}: which measurement produced the band. */
  gpuPressureSource?: PoolPressureSource;
  /**
   * Reserved for peer identity: the answering node's stable pool UUID, learned only from this
   * authenticated response and never from the unauthenticated `/identify` probe.
   */
  nodeUuid?: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserved contract surface.
//
// The types below describe state this build does not produce. They live here, and ship now,
// because five features land on this one module in sequence and each needs the shape of the next
// one's payload to compose with it — a status field that appears and changes shape three times is
// how the hand-mirrored frontend and CLI copies of `PoolStatus` silently drift. Everything is
// optional wherever it touches a live payload, so nothing has to populate it and no default moves.
// ─────────────────────────────────────────────────────────────────────────────

/** Which measurement produced a node's GPU-pressure band. AMD-only today; every other node reports none. */
export type PoolPressureSource = 'host-file' | 'amd-drm' | 'engine-vram';

/** A pin's reach: the pool-wide fallback, or one specific model id. */
export type PoolPinScope = 'default' | 'model';

/**
 * How hard a pin binds. `prefer` only, by decision: a hard `require` makes every model the pinned
 * node lacks an unfailoverable 502, including embeddings, because apps discover the model list from
 * this node while routing to another.
 */
export type PoolPinMode = 'prefer';

/** Where a pin points. `local` is this node; `peer` carries the `hub_pool_peer.id`. */
export type PoolPinTargetKind = 'local' | 'peer';

/**
 * An operator's routing preference for a model. Stored in `HubPoolPreferences` (settings.json), not
 * a table: a dangling target is a `filter` no-op, and a row would have needed an FK whose CASCADE
 * would let a remote peer's unpair destroy this operator's routing policy.
 */
export interface HubPoolPin {
  scope: PoolPinScope;
  /** Set exactly when `scope === 'model'`. Stored verbatim — model ids are case-sensitive and contain `:` and `/`. */
  model?: string;
  targetKind: PoolPinTargetKind;
  /** Set exactly when `targetKind === 'peer'`. */
  peerId?: string;
  mode: PoolPinMode;
}

/** A pin as `/pool/status` reports it: the stored pin plus whether its target can serve right now. */
export interface PoolStatusPin extends HubPoolPin {
  /** The peer's FQDN, or `null` for a local pin — so the UI never has to resolve an id itself. */
  nodeFqdn: string | null;
  /** `false` when the pinned node is gone, disabled, unreachable, or lacks the model: a pin that is silently doing nothing must say so. */
  targetAvailable: boolean;
}

/** How a peer authenticates to this node. `bearer` is the original token; `signed` is a pinned Ed25519 key. */
export type PoolPeerAuthMode = 'bearer' | 'signed';

/** This node's own pool identity, as the operator surfaces show it. Never the private key. */
export interface PoolIdentitySummary {
  nodeUuid: string | null;
  /** A short hash of the public key, for the operator to compare across two screens. Never the key itself. */
  publicKeyFingerprint: string | null;
  /**
   * Why the identity is unusable, when it is. Surfaced exactly as `capabilitiesError` already is:
   * identity bootstrap must degrade and report, never throw out of `onModuleInit` — the encryption
   * key is derived from an env secret, so a regenerated `.env` over a retained volume would
   * otherwise crash-loop every appliance, peerless ones included.
   */
  identityError: string | null;
}

/** An outstanding pairing PIN, as `/pool/status` reports it. The digits are returned exactly once, at mint time, and never here. */
export interface PoolPairingPinState {
  active: boolean;
  expiresAt: string | null;
}

/** What a backend's supervision watcher has observed. Observe-and-report only: the Hub never restarts an inference backend. */
export interface BackendSupervisionSummary {
  backend: InferenceBackendType;
  /** How the backend is actually running, which decides what can be observed about it at all. */
  targetKind: 'container' | 'host-process' | 'remote' | 'absent';
  state: 'healthy' | 'unhealthy' | 'restart-looping' | 'unknown';
  /** dockerd's own `RestartCount`, when the target is a container — the only signal that survives a Hub restart. */
  observedRestartCount: number | null;
  diagnosisCode: string | null;
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
  /**
   * Reserved for LAN discovery: how this candidate was found. Absent means the Tailscale Admin
   * API, which is the only source in this build. A badge rather than a nullable
   * `tailscaleDeviceId`, because widening that field is a type error on the CLI's `sanitizeForBox`
   * and a duplicate React key in the settings list.
   */
  source?: 'tailscale' | 'lan-probe';
  /**
   * Reserved: a UUID the candidate *claims*, from an unauthenticated probe. Typed distinctly from
   * `hub_pool_peer.peer_node_uuid` on purpose — an externally-sourced UUID is a hint for the
   * operator, never an identity key to match a pinned row against.
   */
  claimedNodeUuid?: string;
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

/**
 * The lifecycle values `hub_pool_peer.status` may hold.
 *
 * `'rejected'` was retired in migration 0059 — nothing ever wrote it, and keeping it alongside the
 * `enabled` column would have shipped two overlapping "not in play" concepts. Rejecting a pairing
 * request deletes the row; taking a live peer out of routing sets `enabled = false`. The column
 * itself is a `varchar`, so this union is the contract the hand-mirrored frontend and CLI copies
 * are kept honest against, not a database constraint.
 */
export type PoolPeerStatus = 'pending' | 'connected' | 'unreachable';

/** A peer row plus what this node currently has in flight to it. Built from {@link toPublicPeer}, so the token columns cannot reach it. */
export interface PoolStatusPeer extends PublicHubPoolPeer {
  /** Requests this node has forwarded to the peer and not yet finished reading. A live gauge reset by a restart, never a total. */
  inFlightRequests: number;
  /** Reserved for peer identity: how this peer authenticates to us today. */
  authMode?: PoolPeerAuthMode;
  /** Reserved: a short hash of the peer's pinned public key, for the operator to compare across two screens. */
  peerKeyFingerprint?: string | null;
  /** Reserved for the load signal: the peer's effective (freshness-applied, floored) 0-3 band, or `null` when unmeasured. */
  gpuPressure?: number | null;
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
  /** Reserved for peer identity: this node's UUID, key fingerprint, and why identity is unusable when it is. */
  identity?: PoolIdentitySummary;
  /** Reserved for the load signal: this node's own 0-3 pressure band, or `null` when unmeasured. */
  gpuPressure?: number | null;
  /** Reserved, alongside {@link gpuPressure}. */
  gpuPressureSource?: PoolPressureSource | null;
  /** Reserved for backend supervision: what the observer has seen, per backend. Observe-only. */
  supervision?: BackendSupervisionSummary[];
}

/**
 * Why pooling is or isn't routing right now.
 *
 * `disabled_by_env` and `disabled_by_setting` are kept apart on purpose: the UI must be able to say
 * "your .env overrides this" rather than showing a toggle that appears to do nothing.
 *
 * `partially_disabled` covers every state where pooling is nominally on but one half of it is not
 * running — a direction switched off, or every connected peer individually disabled. It exists so
 * that a node which currently serves nothing cannot report `active`; without it, switching inbound
 * off would leave the badge, the state banner and the CLI all saying "routing normally".
 */
export type PoolStatusReason = 'active' | 'no_peers' | 'partially_disabled' | 'disabled_by_env' | 'disabled_by_setting';

export interface PoolStatus {
  /** Effective kill-switch state (env override applied). Not the same as `settings.poolEnabled`. */
  enabled: boolean;
  disabledBy: HubPoolDisabledBy | null;
  /**
   * Each half of pooling and what is holding it off. `enabled`/`disabledBy` above stay the MASTER
   * switch, unchanged, so their existing consumers keep their meaning; this is the finer state.
   */
  directions: HubPoolDirectionalState;
  reason: PoolStatusReason;
  /** Whether apps are actually being routed through the pool: outbound on AND at least one connected, enabled peer. */
  routingActive: boolean;
  /** The persisted settings as stored, before the env override — what a settings form should render. */
  settings: HubPoolPreferences;
  /** Whether TAILSCALE_OAUTH_CLIENT_ID/SECRET are set, i.e. whether peer discovery can work at all. Never the credentials themselves. */
  tailscaleAdminApiConfigured: boolean;
  localNode: PoolStatusLocalNode;
  peers: PoolStatusPeer[];
  /** `disabled` counts rows the operator switched off, at any status — it is a routing decision, not a lifecycle one, so it overlaps the others. */
  peerCounts: { total: number; connected: number; pending: number; unreachable: number; disabled: number };
  /** Reserved for manual node pinning: the operator's routing preferences, with target availability resolved. */
  pins?: PoolStatusPin[];
  /** Reserved for PIN pairing: whether a pairing PIN is outstanding. Never the digits. */
  pairingPin?: PoolPairingPinState;
}
