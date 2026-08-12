# Private VPN (Tailscale sidecar)

Tailscale gives CI-Hub a private, encrypted way to reach the Hub and installed apps from anywhere without opening inbound ports to the public internet. It is the recommended option when you want simple remote access for operators, support staff, or a small trusted team.

The **`hub-tailscale`** sidecar is **on by default** on every stack (dev, prod, Tauri desktop, docker-only). Compose starts it when **`COMPOSE_PROFILES`** includes **`private-vpn`** (the desktop app and CLI add this automatically). Disable only with an explicit opt-out: **`PRIVATE_VPN_USER_DISABLED=true`** in the hub `.env`, then restart the stack. Legacy **`PRIVATE_VPN_ENABLED`** is not used for gating.

If the host already has Tailscale installed and the Hub can reach `tailscaled.sock`, CI-Hub can use the host client instead of the sidecar.

## Why use Tailscale with CI-Hub

- **Private remote access** to the Hub UI and apps without public DNS or port forwarding
- **Encrypted connections** between approved devices on your tailnet
- **Simple onboarding** from the CI-Hub onboarding flow or **Settings → Network**
- **Per-app remote URLs** when apps are exposed with the `tailscale` exposure mode

## Quick start

### Option 1: Browser sign-in from the Hub UI

This is the easiest option for non-technical users.

1. Start CI-Hub with the default `private-vpn` profile enabled.
2. Open the Hub onboarding flow, or go to **Settings → Network** later.
3. In the **Tailscale** section, click **Log In with Tailscale**.
4. Complete the sign-in flow in the browser window that opens.
5. Return to CI-Hub and confirm the Tailscale status shows as connected.

After connection, the UI shows the Hub's Tailscale IP address and hostname. Save that hostname for remote administration.

### Option 2: Unattended setup with an auth key

This is useful for pre-provisioned devices or admin-managed deployments.

1. Generate a Tailscale auth key in the Tailscale admin console.
2. Add it to the Hub environment as **`TAILSCALE_AUTHKEY`**.
3. Start or restart the Hub.
4. Confirm the device appears in your tailnet and that **Settings → Network** shows the connection as active.

> CI-Hub also accepts the legacy variable **`HEADSCALE_PREAUTH_KEY`**, but new deployments should use **`TAILSCALE_AUTHKEY`**.

## Required configuration

- **Disable (explicit opt-out):** set **`PRIVATE_VPN_USER_DISABLED=true`** in the hub `.env` and restart. When enabled (default), omit that variable and ensure **`COMPOSE_PROFILES`** includes **`private-vpn`**.
- **Auth:** set **`TAILSCALE_AUTHKEY`** for unattended setup, or use browser sign-in from the Hub UI.
- **Routes:** by default **`HUB_TAILSCALE_EXTRA_ARGS`** targets the public Tailscale control plane and advertises `172.18.0.0/16` so tailnet clients can reach the Hub's Docker bridge. Change this if your Docker network uses a different CIDR.
- **Sidecar name:** CI-Hub uses **`TAILSCALE_SIDECAR_CONTAINER`** when it needs to run `docker exec ... tailscale ...` against a non-default container name.

The backend **`TailscaleService`** talks to Tailscale via `docker exec hub-tailscale tailscale …` when the Hub container has no host Tailscale socket.

## Accessing the Hub and apps over Tailscale

### Access the Hub itself

Once connected, look in **Settings → Network** for the hostname shown by Tailscale.

While the VPN is connected, CI-Hub publishes its own dashboard on the tailnet
via Tailscale Serve:

```text
https://<device-name>.<tailnet>.ts.net/
```

This is also the origin the memory-connect / login ceremony uses for callers
arriving over the VPN, so it must stay published for those flows to work.
Publishing requires **MagicDNS** and **HTTPS Certificates** to be enabled for
the tailnet (Tailscale admin console → DNS) — the same requirement as per-app
Serve.

When CI-Hub uses a **host** Tailscale client instead of the sidecar (the host
has a reachable `tailscaled.sock`), the dashboard is additionally reachable on
the Hub API port directly (`http://<device-name>:5002/`). With the default
**sidecar** deployment that direct-port form does NOT work — the sidecar is a
separate container and forwards nothing on its own; only the Serve entries
above are published.

> **Subnet routes caveat:** the sidecar advertises `172.18.0.0/16` (the Hub's
> Docker bridge) as a fallback path. Linux clients do not accept subnet routes
> by default (`--accept-routes`), the route must be approved in the admin
> console, and any client that itself runs Docker typically owns the same
> subnet locally — accepting the route there would capture that client's own
> Docker traffic. Prefer the Serve URLs; treat the subnet route as opt-in for
> clients that understand the trade-off.

### Access apps with Tailscale URLs

When you install or update an app and choose **Tailscale** as the exposure mode, CI-Hub keeps Tailscale Serve in sync for that app.

CI-Hub publishes each app on a dedicated HTTPS port on the Hub node:

```text
https://<device-name>.<tailnet>.ts.net:<app-port>/
```

For example, an app assigned port `8138` is available at
`https://hub-demo.example.ts.net:8138/`. Open the generated URL shown by CI-Hub
and test it from another device signed in to the same tailnet.

## Remote administration workflow

Recommended operator workflow:

1. **Install or open Tailscale** on your laptop, phone, or support workstation.
2. **Join the same tailnet** as the CI-Hub device.
3. In CI-Hub, verify **Settings → Network** shows Tailscale as active.
4. Use the Hub hostname to open the admin UI remotely.
5. For an app that should stay private, select **Tailscale** as its exposure mode during install or update.
6. Share the resulting Tailscale URL only with tailnet members who should have access.

This workflow is ideal for remote maintenance, operator access, and private demos without exposing the Hub publicly through Cloudflare Tunnel.

## Security and best practices

- Prefer **Tailscale for private admin access** and use Cloudflare Tunnel only when you need internet-facing sharing.
- Use **auth keys created for the correct environment** and rotate them when staff or devices change.
- Treat **`TAILSCALE_AUTHKEY`** like a secret. Do not paste it into screenshots, tickets, or chat messages.
- Review which users and devices are approved in the Tailscale admin console.
- Keep the advertised route in **`HUB_TAILSCALE_EXTRA_ARGS`** limited to the networks CI-Hub actually needs to expose.
- If you use the host Tailscale client instead of the sidecar, make sure the Hub only has access to the socket intentionally.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| **Tailscale section says not available** | Make sure the `private-vpn` profile is running, or install Tailscale on the host and mount the daemon socket into the Hub container. |
| **Browser login opens but CI-Hub never shows connected** | Wait a few seconds for the status refresh, then revisit **Settings → Network**. Confirm the device appears in the Tailscale admin console. |
| **Auth key login fails immediately** | Verify the key starts with `tskey-auth-` and is still valid in the Tailscale admin console. |
| **Remote device cannot reach the Hub or apps** | Confirm the remote device is logged in to the same tailnet and that the advertised route in `HUB_TAILSCALE_EXTRA_ARGS` matches the Docker network used by the Hub. |
| **Logs still mention `headscale:8080` after upgrading** | Reconnect Tailscale once so the device state is rewritten against `controlplane.tailscale.com`. If you override `HUB_TAILSCALE_EXTRA_ARGS`, keep an explicit `--login-server=https://controlplane.tailscale.com` unless you intentionally run your own control plane. |
| **App URL works locally but not via Tailscale** | Confirm the Hub and client are on the same tailnet, approve the HTTPS/Serve consent link shown by Hub if needed, then re-save the app with **Tailscale** exposure mode. |
| **Need to turn Tailscale off temporarily** | Set `PRIVATE_VPN_USER_DISABLED=true` in the hub `.env` and restart the stack. |

## Example operator checklist

Use this short checklist during onboarding or handoff:

- [ ] Device is connected to the correct tailnet
- [ ] **Settings → Network** shows Tailscale as active
- [ ] Hub hostname has been tested from a second device
- [ ] Any private apps that need remote access are set to **Tailscale** exposure mode
- [ ] Auth keys are stored securely and rotated when needed
