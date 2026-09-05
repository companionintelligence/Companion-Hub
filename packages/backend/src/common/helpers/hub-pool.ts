/** Which of the two kill switches turned Hub pooling off. `null` when it is on. */
export type HubPoolDisabledBy = 'env' | 'setting';

export interface HubPoolEnabledState {
  enabled: boolean;
  disabledBy: HubPoolDisabledBy | null;
}

/**
 * Multi-Hub inference pooling kill switch. Existing pairing state is unaffected —
 * this gates whether a connected peer is treated as usable
 * (`HubPoolPeerService.hasConnectedPeers`), whether this node still answers peer
 * capability probes, and whether it accepts new pairing requests, so a disabled
 * Hub stops routing through the pool and naturally reads as unreachable to its
 * peers.
 *
 * Two switches, and the environment wins. `HUB_POOL_USER_DISABLED=true` in the hub
 * `.env` (matching the `PRIVATE_VPN_USER_DISABLED` convention) is an operator-of-the-box
 * decision that a UI toggle must not be able to undo; the persisted `hubPoolEnabled`
 * setting is the in-product switch and is opt-out, so `undefined` means on. The two are
 * reported separately rather than collapsed into one boolean precisely so the UI can say
 * "disabled in the .env" instead of showing a toggle that silently does nothing.
 *
 * Deliberately NOT projected into `.env` by `generateSystemEnvFile`: routing the setting
 * through `HUB_POOL_USER_DISABLED` would make `resolve()`'s env-first precedence apply to
 * the Hub's own persisted value, and the operator could never turn pooling back on from
 * the UI once the flag had been written to disk.
 */
export function resolveHubPoolEnabled(persistedEnabled: boolean | undefined): HubPoolEnabledState {
  if (process.env.HUB_POOL_USER_DISABLED === 'true') {
    return { enabled: false, disabledBy: 'env' };
  }
  if (persistedEnabled === false) {
    return { enabled: false, disabledBy: 'setting' };
  }
  return { enabled: true, disabledBy: null };
}

/** {@link resolveHubPoolEnabled} when only the yes/no answer is wanted. */
export function isHubPoolEnabled(persistedEnabled?: boolean): boolean {
  return resolveHubPoolEnabled(persistedEnabled).enabled;
}

/**
 * Message for a 503 refusing a peer because pooling is off here. Names the switch that is actually
 * responsible: an operator told "set HUB_POOL_USER_DISABLED" when the real cause is the UI toggle
 * would go looking in the wrong file.
 */
export function describeHubPoolDisabled(disabledBy: HubPoolDisabledBy | null): string {
  return disabledBy === 'setting'
    ? 'Hub pooling is disabled on this node (turned off in Settings → Network → Hub Pool)'
    : 'Hub pooling is disabled on this node (HUB_POOL_USER_DISABLED)';
}

/**
 * The head start the local node gets over a peer, in queued requests.
 *
 * This is a real advantage, not favouritism: a follow-up turn served here reuses the prompt prefix
 * and KV cache the previous turn left resident, while the same turn sent to a peer re-processes the
 * whole prompt cold. One queued request is roughly what that re-processing costs, so work only
 * leaves this node once a peer is at least that much emptier. 0 makes the pool a pure least-loaded
 * balancer; higher values make handoff rarer (stickier to local).
 */
export const DEFAULT_POOL_LOCAL_AFFINITY = 1;
export const MIN_POOL_LOCAL_AFFINITY = 0;
/** Above this the local node effectively never hands off, which is indistinguishable from disabling the pool — use the kill switch for that instead. */
export const MAX_POOL_LOCAL_AFFINITY = 20;

/** How often each `connected`/`unreachable` peer is probed for capabilities. */
export const DEFAULT_POOL_HEALTH_POLL_SECONDS = 30;
/** Below this the probes cost more than the routing accuracy they buy, and an 8s probe timeout would start overlapping ticks. */
export const MIN_POOL_HEALTH_POLL_SECONDS = 10;
/** Above this a peer can be down for over 15 minutes (three strikes) before it stops being offered as a candidate. */
export const MAX_POOL_HEALTH_POLL_SECONDS = 300;

/**
 * How many health polls a peer's capability snapshot stays trusted for, after which its
 * self-reported load is discarded and it ranks as mid-load. Matches the three strikes that mark a
 * peer unreachable — a peer still `connected` but two polls behind is exactly the case this covers.
 * Expressed in polls rather than milliseconds so it tracks a retuned poll interval automatically.
 */
export const CAPABILITIES_FRESHNESS_POLLS = 3;

/** Operator-editable pool tuning, resolved against the DEFAULT_POOL_* constants. */
export interface HubPoolPreferences {
  /** The persisted half of the kill switch only — pass it through {@link resolveHubPoolEnabled} to get the effective state. */
  poolEnabled: boolean;
  poolLocalAffinity: number;
  poolHealthPollSeconds: number;
}

const MAX_FQDN_LENGTH = 253;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonicalizes a peer node FQDN, or returns `null` when the value is anything
 * but a bare multi-label hostname.
 *
 * A peer FQDN is both the unique key of its `hub_pool_peer` row and the host
 * this Hub interpolates into `https://<fqdn>/api/inference/pool/...` on every
 * handshake and health call, and pairing requests arrive unauthenticated — so a
 * value carrying a scheme, credentials, port, path, query or fragment would let
 * the requester choose where those calls (and the token they carry) go. Only the
 * MagicDNS shape Tailscale actually hands out is accepted; IP literals are
 * refused as well, since the tailnet name is the trust anchor and an address
 * bypasses the hostname-based TLS check.
 */
export function normalizePeerFqdn(raw: string): string | null {
  // A single trailing dot is the legal absolute-DNS form of the same name; anything else
  // (empty labels, leading dots) falls out of the per-label check below.
  const candidate = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || candidate.length > MAX_FQDN_LENGTH) {
    return null;
  }

  const labels = candidate.split('.');
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL.test(label))) {
    return null;
  }
  // `1.2.3.4` and `12345.67890` pass the label check but are addresses, not names.
  if (/^\d+$/.test(labels[labels.length - 1] as string)) {
    return null;
  }

  return candidate;
}
