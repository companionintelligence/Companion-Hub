# Private VPN (Headscale) — operator checklist

This Hub runs Headscale and enrolls `hub-tailscale` automatically. For **phones and laptops on the internet** to join, they need a **public HTTPS URL** that matches Headscale’s `server_url`, not the internal Docker name `http://headscale:8080`.

## Three different “DNS” ideas (do not mix them)

| Topic | What it is | Your action |
| --- | --- | --- |
| **Provider DNS** | So `headscale.yourdomain.com` resolves to your Hub’s **public IP** | **A** or **AAAA** record at your DNS host |
| **Headscale `server_url` + registration links** | Headscale builds `/register/...` URLs from `server_url` | Must be a **public HTTPS URL** (configured via env; see below) |
| **Tailscale app “Custom DNS”** (e.g. 8.8.8.8) | Resolver for queries over the tailnet | **Optional** — not required to find Headscale |

## Configuration (env)

- **`PRIVATE_VPN_ENABLED`** — default on (anything other than `false` enables Headscale + `hub-tailscale`). When `false`, those services are not started (Docker Compose profile `private-vpn`). `bun scripts/start.ts` and the desktop Hub set `COMPOSE_PROFILES` so the profile is applied unless you disable VPN here.

Set one of these for **`server_url`** / login server (precedence top to bottom; tunnel hostname is computed when the hub is **registered** and VPN is on):

- **`HEADSCALE_PUBLIC_URL`** — full URL; the origin is used, e.g. `https://headscale.example.com`
- **`HEADSCALE_PUBLIC_HOST`** — hostname only, HTTPS assumed, e.g. `headscale.example.com`
- **Tunnel hostname** — when registered with CI Cloud, **`https://vpn-{device}-{org}.<your portal domain>`** (same value sent in tunnel sync). Overrides the `headscale.<DOMAIN>` default below when registration + `userSettings.domain` are present.
- **`DOMAIN` only** — if none of the above apply, the Hub uses **`https://headscale.<DOMAIN>`** (ensure DNS exists for that name)

**`HEADSCALE_TUNNEL_PORT`** — port on the `headscale` container for tunnel ingress (default **8080**). Sync payload uses this so CI-Cloud routes to Headscale directly, not Traefik `:80`.

The Hub writes Headscale `config.yaml` and a Traefik file-provider route when a public host is known so **`Host(…)`** can terminate TLS (Let’s Encrypt) and proxy to `headscale:8080` for direct HTTPS access.

## DNS and firewall

1. Create **A** (or **AAAA**) for the hostname you use (e.g. `headscale.example.com` or `headscale.<DOMAIN>`) → your Hub’s **public** IP.
2. Allow **80** (HTTP-01) and **443** (HTTPS) to Traefik on that host (or your tunnel equivalent).
3. Restart the stack or Hub after changing env so config and the dynamic Traefik file are regenerated.

## End users (short path)

1. **Settings → Network** — copy **Tailscale login server** and **Generate Key**.
2. On the device: install Tailscale, then  
   `tailscale up --login-server=<copied URL> --authkey=<key>`  
   or set the same login server in the Tailscale app as the **custom coordination server**.

See also: [Tailscale: custom control server](https://tailscale.com/docs/how-to/set-up-custom-control-server).
