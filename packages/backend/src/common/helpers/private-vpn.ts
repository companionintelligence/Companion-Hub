/**
 * Private VPN: Docker `private-vpn` profile starts the `hub-tailscale` sidecar (Tailscale client).
 * Enabled only when PRIVATE_VPN_ENABLED is exactly `true`. Missing key ⇒ disabled (safe default for fresh installs).
 */
export function isPrivateVpnEnabled(): boolean {
  return process.env.PRIVATE_VPN_ENABLED === 'true';
}
