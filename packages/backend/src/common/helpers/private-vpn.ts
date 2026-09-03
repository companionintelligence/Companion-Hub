/**
 * Private VPN: Docker `private-vpn` profile starts the `hub-tailscale` sidecar (Tailscale client).
 *
 * Enabled by default on every stack (dev, prod, Tauri, docker-only). Disabled only when the user
 * explicitly opts out via `PRIVATE_VPN_USER_DISABLED=true` in the hub `.env`. Compose activation
 * is via `COMPOSE_PROFILES` including `private-vpn` (written by the desktop app / CLI).
 *
 * Legacy `PRIVATE_VPN_ENABLED` is not read — older installs often had `false` without user intent.
 */
export function isPrivateVpnEnabled(): boolean {
  return process.env.PRIVATE_VPN_USER_DISABLED !== 'true';
}
