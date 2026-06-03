/**
 * Private VPN: Docker `private-vpn` profile starts the `hub-tailscale` sidecar (Tailscale client).
 * Enabled by default. Disabled only when the user opts out (`PRIVATE_VPN_USER_DISABLED=true`)
 * or legacy `PRIVATE_VPN_ENABLED=false` is set.
 */
export function isPrivateVpnEnabled(): boolean {
  if (process.env.PRIVATE_VPN_USER_DISABLED === 'true') {
    return false;
  }
  if (process.env.PRIVATE_VPN_ENABLED === 'false') {
    return false;
  }
  return true;
}
