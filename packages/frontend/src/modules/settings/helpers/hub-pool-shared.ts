/* Shapes mirrored by hand from the backend: every pool route has an empty response schema in
   swagger.json, so the generated SDK types these payloads as `unknown`. The authoritative source is
   `hub-pool.types.ts` (PoolStatus). Shared by the Hub Pool panel and the setup guide, so neither imports the other. */

export interface PoolBackendCapability {
  type: string;
  healthy: boolean;
  modelsLoaded: string[];
}

/**
 * Why a peer's health probes are failing, and what to do about it, mirrored from the backend's
 * `PoolPeerProbeFailure` (`hub-pool-probe-failure.ts`). Only `kind`, `action` and `httpStatus` are read here —
 * `action` is `null` exactly for `'unreachable'`, the one kind the backend expects to clear on its
 * own, so "is action present" is what actually distinguishes "wait" from "go do something."
 */
export interface PoolPeerProbeFailureSummary {
  kind: 'unreachable' | 'unauthorized' | 'identity_changed';
  action: string | null;
  /** The HTTP status the failed probe got back, when it got one. The backend serializes it; `null` for a network-level failure. */
  httpStatus?: number | null;
}

export interface PoolPeerCapabilities {
  hardwareTier: string;
  backends: PoolBackendCapability[];
  inFlightRequests?: number;
  /** The far side told us it is not taking work right now. Absent on a peer running an older build. */
  acceptingWork?: boolean;
  updatedAt: string;
}

/* 'rejected' was retired in migration 0059 — nothing ever wrote it, and it overlapped `enabled`. */
export type PoolPeerStatus = 'pending' | 'connected' | 'unreachable';

export interface PoolPeer {
  id: string;
  nodeFqdn: string;
  displayName: string | null;
  direction: 'inbound' | 'outbound';
  status: PoolPeerStatus;
  /** Per-peer kill switch. Not a lifecycle state: a disabled peer can be `connected` and healthy. */
  enabled: boolean;
  consecutiveFailures: number;
  /** Why this peer's probes are failing, or `null`/absent while they succeed. Process-local on the backend. */
  probeFailure?: PoolPeerProbeFailureSummary | null;
  lastSeenAt: string | null;
  lastCapabilities: PoolPeerCapabilities | null;
  inFlightRequests: number;
  /** How this peer authenticates to us: the original token, or a pinned Ed25519 key. */
  authMode?: 'bearer' | 'signed';
  /** A short hash of the peer's pinned public key. Never the key — the fingerprint is what a human compares. */
  peerKeyFingerprint?: string | null;
}

/**
 * An operator routing pin, as `/status` reports it. `targetAvailable` is the field this card exists
 * to surface: a `prefer` pin never errors, so a pin at a node that is unreachable, disabled,
 * unpaired, or simply no longer holding the model is invisible everywhere else.
 */
export interface PoolPin {
  scope: 'default' | 'model';
  model?: string;
  targetKind: 'local' | 'peer';
  peerId?: string;
  mode: 'prefer';
  nodeFqdn: string | null;
  targetAvailable: boolean;
}

export interface PoolSettings {
  poolEnabled: boolean;
  poolOutboundEnabled: boolean;
  poolInboundEnabled: boolean;
  poolLocalAffinity: number;
  poolHealthPollSeconds: number;
  poolRequireSignedPeers: boolean;
  /** Absent on a Hub predating prefix affinity, where it was off. */
  poolPrefixAffinityMaxInFlight?: number;
  /** Absent on a Hub predating the margin. */
  poolPrefixAffinityMargin?: number;
  /** Optional so a cached payload from a build before the switch reads as off, which is its default. */
  poolMdnsEnabled?: boolean;
}

/** This node's own pool identity. Never the private key — only the UUID and a short fingerprint. */
export interface PoolIdentitySummary {
  nodeUuid: string | null;
  publicKeyFingerprint: string | null;
  /** Why identity is unusable, when it is — surfaced the same way `capabilitiesError` is. */
  identityError: string | null;
}

/** An outstanding pairing PIN. The digits are returned exactly once, by the mint call, and never here. */
export interface PoolPairingPinState {
  active: boolean;
  expiresAt: string | null;
}

export interface PoolEnabledState {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
}

export interface PoolStatus {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
  directions: { outbound: PoolEnabledState; inbound: PoolEnabledState };
  reason: 'active' | 'no_peers' | 'partially_disabled' | 'disabled_by_env' | 'disabled_by_setting';
  routingActive: boolean;
  settings: PoolSettings;
  tailscaleAdminApiConfigured: boolean;
  localNode: {
    nodeFqdn: string | null;
    tailnet: string | null;
    tailscaleConnected: boolean;
    inFlightRequests: number;
    hardwareTier: string | null;
    backends: PoolBackendCapability[];
    capabilitiesError: string | null;
    identity?: PoolIdentitySummary;
  };
  peers: PoolPeer[];
  peerCounts: { total: number; connected: number; pending: number; unreachable: number; disabled: number };
  /** Optional here, unlike on the backend, so a stale cached payload cannot blank the whole card. */
  pins?: PoolPin[];
  pairingPin?: PoolPairingPinState;
  routing: { recorded: number; capacity: number; served: number; failed: number; failovers: number; lastAt: string | null };
}

/**
 * An unpaired node this Hub can offer to pair with **by name**, from any directory that can attest
 * one: the tailnet (the local Tailscale daemon's peer map, plus the Admin API when a credential is
 * configured) or the CI Portal device registry. The backend merges the two, so a node both know
 * appears once; which of those two directories named it is not rendered.
 *
 * The one other kind of row is an UNVERIFIED one — a Hub heard over LAN mDNS, when that is switched
 * on. Every field of it came from an unauthenticated datagram, so it is shown for the operator to
 * read and never gets a Pair button: clicking one would send this Hub's name, a fresh peer token and
 * any typed PIN to whatever host the packet named. See {@link isUnverifiedCandidate}.
 *
 * A Hub found by typed address is not in here either: `GET /identify` is unauthenticated and reports
 * no MagicDNS name, so an address has no name to hand the Pair button. Those are paired with from the
 * CLI, where the operator also supplies the PIN that makes the far side disclose its name —
 * `cihub pool pair <address> --pin <digits>`.
 */
export interface DiscoverablePoolPeer {
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
  /** The OS the tailnet reports for the device (`linux`, `macOS`, `windows`, ...). Display only; absent when not reported. */
  os?: string;
  /** Whether the tailnet reports the device online right now. Display only; absent when not reported. */
  online?: boolean;
  source?: 'portal' | 'mdns';
  verified?: boolean;
  /** `host:port` of an unverified mDNS row — the datagram's sender. Display only. */
  address?: string;
}

/**
 * Either mark makes a row unverified. `source` alone covers a Hub on the build that introduced mDNS
 * discovery, which sent neither the flag nor any restraint on what its rows carried.
 */
export const isUnverifiedCandidate = (device: DiscoverablePoolPeer) => device.verified === false || device.source === 'mdns';

export const peerLabel = (peer: { displayName: string | null; nodeFqdn: string }) => peer.displayName || peer.nodeFqdn;

/**
 * What the pool can actually serve: every model any reachable node reports, and which nodes have it.
 * Unreachable peers are left out on purpose — their `lastCapabilities` is a cached snapshot of a node
 * that is not currently answering, so listing it would promise capacity the pool cannot deliver.
 */
export const mergePoolModels = (status: PoolStatus, localLabel: string): Array<{ model: string; nodes: string[] }> => {
  const byModel = new Map<string, Set<string>>();
  const add = (model: string, node: string) => {
    const nodes = byModel.get(model) ?? new Set<string>();
    nodes.add(node);
    byModel.set(model, nodes);
  };

  for (const backend of status.localNode.backends) {
    if (!backend.healthy) continue;
    for (const model of backend.modelsLoaded) add(model, localLabel);
  }
  for (const peer of status.peers) {
    if (peer.status !== 'connected') continue;
    for (const backend of peer.lastCapabilities?.backends ?? []) {
      if (!backend.healthy) continue;
      for (const model of backend.modelsLoaded) add(model, peerLabel(peer));
    }
  }

  return [...byModel.entries()]
    .map(([model, nodes]) => ({ model, nodes: [...nodes].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.model.localeCompare(b.model));
};
