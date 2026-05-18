# Private VPN (Tailscale sidecar)

When **`PRIVATE_VPN_ENABLED`** is not `false`, the Hub enables the Docker Compose profile `private-vpn`, which runs the **`hub-tailscale`** container.

- **Auth:** set **`TAILSCALE_AUTHKEY`** (or legacy **`HEADSCALE_PREAUTH_KEY`**) to a [Tailscale pre-auth key](https://login.tailscale.com/admin/settings/keys). The sidecar joins **tailscale.com’s coordination service** (there is no bundled Headscale server).
- **Routes:** by default **`HUB_TAILSCALE_EXTRA_ARGS`** advertises `172.18.0.0/16` so tailnet clients can reach the Hub’s Docker bridge; adjust if your Docker network uses a different CIDR.
- **Disable:** set **`PRIVATE_VPN_ENABLED=false`** in `.env` (desktop Hub and `scripts/start.ts` keep `COMPOSE_PROFILES` in sync).

The backend **`TailscaleService`** talks to Tailscale via `docker exec hub-tailscale tailscale …` when the Hub container has no host Tailscale socket.
