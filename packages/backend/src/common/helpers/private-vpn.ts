/**
 * Private VPN: Docker `private-vpn` profile starts the `hub-tailscale` sidecar (Tailscale client).
 * Disabled when PRIVATE_VPN_ENABLED is exactly `false`.
 */
export function isPrivateVpnEnabled(): boolean {
  return process.env.PRIVATE_VPN_ENABLED !== 'false';
}
