/**
 * The two Private VPN switches in the hub `.env`. They answer different questions, so they are
 * separate variables.
 *
 * `PRIVATE_VPN_USER_DISABLED=true` keeps the `hub-tailscale` sidecar (the `private-vpn` compose
 * profile) from starting. Only the CLI (`scripts/lib/cli-compose-env.ts`) reads it, when it builds
 * `COMPOSE_PROFILES`. The backend ignores it: a Hub that uses the host's Tailscale client needs no
 * sidecar, yet still publishes itself and its Private VPN apps through the host's Tailscale Serve,
 * and fleet nodes set it for exactly that reason, to stop the sidecar's crash loop. The desktop app
 * also wrote it on every start that found neither a Tailscale key nor a saved login, so nearly
 * every desktop install carried it without anyone asking. Reading it as "leave Tailscale Serve
 * alone" (#1489) left Private VPN apps unpublished on those installs from 0.2.73 on (CI-Hub#1757).
 *
 * `TAILSCALE_SERVE_USER_DISABLED=true` is the switch for that: the Hub never writes Tailscale Serve
 * config. It publishes neither its own `https://<node>/` entry nor any Private VPN app, removes
 * nothing it published before, and the UI stops offering Private VPN. Only an operator sets it.
 *
 * Legacy `PRIVATE_VPN_ENABLED` is not read — older installs often had `false` without user intent.
 */
export const TAILSCALE_SERVE_DISABLED_ENV_VAR = 'TAILSCALE_SERVE_USER_DISABLED';

/** Whether the Hub may write Tailscale Serve config; false only when an operator opted out. */
export function isTailscaleServeEnabled(): boolean {
  return process.env[TAILSCALE_SERVE_DISABLED_ENV_VAR] !== 'true';
}
