# Private VPN (Tailscale sidecar)

Tailscale gives CI-Hub a private, encrypted way to reach the Hub and installed apps from anywhere without opening inbound ports to the public internet. It is the recommended option when you want simple remote access for operators, support staff, or a small trusted team.

When **`PRIVATE_VPN_ENABLED`** is not `false`, the Hub enables the Docker Compose profile `private-vpn`, which runs the **`hub-tailscale`** container. If the host already has Tailscale installed and the Hub can reach `tailscaled.sock`, CI-Hub can use the host client instead of the sidecar.

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

- **Enable / disable:** set **`PRIVATE_VPN_ENABLED=false`** in `.env` to disable the sidecar entirely.
- **Auth:** set **`TAILSCALE_AUTHKEY`** for unattended setup, or use browser sign-in from the Hub UI.
- **Routes:** by default **`HUB_TAILSCALE_EXTRA_ARGS`** advertises `172.18.0.0/16` so tailnet clients can reach the Hub's Docker bridge. Change this if your Docker network uses a different CIDR.
- **Sidecar name:** CI-Hub uses **`TAILSCALE_SIDECAR_CONTAINER`** when it needs to run `docker exec ... tailscale ...` against a non-default container name.

The backend **`TailscaleService`** talks to Tailscale via `docker exec hub-tailscale tailscale …` when the Hub container has no host Tailscale socket.

## Accessing the Hub and apps over Tailscale

### Access the Hub itself

Once connected, look in **Settings → Network** for the hostname shown by Tailscale.

Typical Hub access patterns are:

- **MagicDNS hostname:** `https://<device-name>.<tailnet>.ts.net/`
- **Tailscale IP:** `https://100.x.y.z/` or `http://100.x.y.z/` if you are testing directly inside the tailnet

Example:

```text
https://hub-demo.example.ts.net/
```

### Access apps with Tailscale URLs

When you install or update an app and choose **Tailscale** as the exposure mode, CI-Hub keeps Tailscale Serve in sync for that app.

CI-Hub supports two URL patterns depending on the Tailscale version:

| Mode | URL pattern | Example |
| --- | --- | --- |
| **Tailscale Services** (newer Tailscale versions) | `https://<app>-<device-name>.<tailnet>.ts.net/` | `https://nextcloud-hub-demo.example.ts.net/` |
| **Path-based serve** (fallback) | `https://<device-name>.<tailnet>.ts.net/<app>/` | `https://hub-demo.example.ts.net/nextcloud/` |

If you are not sure which format your device is using, open the app from CI-Hub after selecting the **Tailscale** exposure mode and test it from another device already signed in to the same tailnet.

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
| **App URL works locally but not via Tailscale** | Re-save the app with **Tailscale** exposure mode, then check that the Hub itself is connected to Tailscale before testing again. |
| **Need to turn Tailscale off temporarily** | Set `PRIVATE_VPN_ENABLED=false` and restart the Hub. |

## Example operator checklist

Use this short checklist during onboarding or handoff:

- [ ] Device is connected to the correct tailnet
- [ ] **Settings → Network** shows Tailscale as active
- [ ] Hub hostname has been tested from a second device
- [ ] Any private apps that need remote access are set to **Tailscale** exposure mode
- [ ] Auth keys are stored securely and rotated when needed
