/**
 * Multi-Hub inference pooling kill switch. Pairing state and pairing itself are
 * unaffected — this only gates whether a connected peer is treated as usable
 * (`HubPoolPeerService.hasConnectedPeers`) and whether this node still answers
 * peer capability probes, so a disabled Hub simply stops routing through the
 * pool and naturally reads as unreachable to its peers.
 *
 * On by default whenever peers exist; disable with `HUB_POOL_USER_DISABLED=true`
 * in the hub `.env`, matching the `PRIVATE_VPN_USER_DISABLED` convention.
 */
export function isHubPoolEnabled(): boolean {
  return process.env.HUB_POOL_USER_DISABLED !== 'true';
}
