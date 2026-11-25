# Private VPN (Tailscale sidecar)

Tailscale gives CI-Hub a private, encrypted way to reach the Hub and installed apps from anywhere without opening inbound ports to the public internet. It is the recommended option when you want simple remote access for operators, support staff, or a small trusted team.

The **`hub-tailscale`** sidecar is **on by default** on every stack (dev, prod, Tauri desktop, docker-only). Compose starts it when **`COMPOSE_PROFILES`** includes **`private-vpn`** (the desktop app and CLI add this automatically once the sidecar has an auth key or a saved login). To turn the sidecar or the Hub's Tailscale Serve entries off, see [Turn Private VPN off](#turn-private-vpn-off). Legacy **`PRIVATE_VPN_ENABLED`** is not used for gating.

If the host already has Tailscale installed and the Hub can reach `tailscaled.sock`, CI-Hub can use the host client instead of the sidecar.

## Why use Tailscale with CI-Hub

- **Private remote access** to the Hub UI and apps without public DNS or port forwarding
- **Encrypted connections** between approved devices on your tailnet
- **Simple onboarding** from the CI-Hub onboarding flow or **Settings → Network**
- **Per-app remote URLs** when apps are exposed with the `tailscale` exposure mode

## Quick start

### Option 1: Browser sign-in from the Hub UI

Use this option when you set up Tailscale from the Hub UI.

1. Start CI-Hub with the default `private-vpn` profile enabled.
2. Open the Hub onboarding flow, or go to **Settings → Network** later.
3. In the **Tailscale** section, select **Log In with Tailscale**.
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

- **Disable:** two switches in the hub `.env` turn off the sidecar and the Hub's Tailscale Serve entries separately. See [Turn Private VPN off](#turn-private-vpn-off).
- **Auth:** set **`TAILSCALE_AUTHKEY`** for unattended setup, or use browser sign-in from the Hub UI.
- **Routes:** by default **`HUB_TAILSCALE_EXTRA_ARGS`** targets the public Tailscale control plane and advertises `172.18.0.0/16` so tailnet clients can reach the Hub's Docker bridge. Change this if your Docker network uses a different CIDR. It only applies to the sidecar. A Hub that uses the computer's own Tailscale signs in with a plain `tailscale up` and keeps that machine's settings as they are. If that Tailscale holds settings a plain `tailscale up` can't leave out, the Hub repeats the ones Tailscale names.
- **Sidecar name:** CI-Hub uses **`TAILSCALE_SIDECAR_CONTAINER`** when it needs to run `docker exec ... tailscale ...` against a non-default container name.

The backend **`TailscaleService`** talks to Tailscale via `docker exec hub-tailscale tailscale …` when the Hub container has no host Tailscale socket.

> Pooling inference capacity across multiple CI-Hub devices on the same tailnet is a separate, opt-in feature built on top of this connection — see [`hub-pool.md`](hub-pool.md).

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

With a host Tailscale client, the Hub writes Serve config through the host's
`tailscaled`, which accepts writes only from root or the host's Tailscale
operator. If the Hub runs as an ordinary account, the Hub logs one warning with
the command that makes that account the operator, and skips publishing until you
run it on the host. **Settings → Network** shows the same reason and command,
with a copy button, and the access card of each unpublished Private VPN app says
that Tailscale refused the change instead of **Pending**. Both clear once
`tailscaled` accepts the Hub's next change. The account differs between hosts
(uid 1000 on most appliances, 1001 on some), so use the command from the
warning, or find the account with
`ps -o user= -p "$(docker inspect -f '{{.State.Pid}}' ci-hub)"` and
run `sudo tailscale set --operator=<account>`.

The Hub checks that the entry answers for the device's current name. If you
rename the device in the Tailscale admin console, the next exposure sync (every
five minutes) publishes the Hub under the new name. The old name's entry stays in
the Serve config, but nothing resolves that name any more. If
`TAILSCALE_SERVE_USER_DISABLED=true` is set, the Hub does not republish itself; it
logs one warning with the `tailscale serve` command to run instead.

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

While an app is on Private VPN, CI-Hub doesn't publish its port on the host, even
if the app had one open on **This machine only** before. Serve listens on that
same port. A host publish of it would answer the Hub's own computer in Serve's
place over plain HTTP, where the link fails with "wrong version number". The
app's `http://<lan-address>:<app-port>` link comes back when you move it back to
**This machine only**.

The Hub checks whether an app is up by connecting to its address from where the
Hub runs. When the Hub runs in a container, that is a Docker network, and a
`tailscaled` that binds its Serve listeners to the Tailscale device (seen with
1.104.7) refuses a connection that arrives there, even though every device on the
tailnet connects. A Hub that uses the host's Tailscale also misses Serve for a
port that a program on the host listens on too, such as one added with **Expose a
port**: its connection to its own tailnet address lands on that plain-HTTP port.
The TLS handshake then fails with "wrong version number" or "packet length too
long". When the Hub is refused or gets one of those
two errors, and the tailnet has HTTPS certificates, it reads `tailscale serve status`,
finds the entry for the app's port under the device's current name, and sends a
request to the target that entry forwards to. If the target is an IP address on a
private network, which is what the Hub writes (the app container's address on its
app network, or for a port added with **Expose a port** the address
`host.docker.internal` has inside the Hub's container), and it answers, the app
reads as available. In every other case the
app reads as **App not responding**: the port has no entry, the target doesn't
answer, or the target is a host name such as `host.docker.internal` or
`localhost`, which the Hub's container and the host's `tailscaled` can read
differently.

When an app stops, CI-Hub removes the Serve entry it published for that app. It
removes only entries it published, which it records in
`state/tailscale-serve-ownership.json` under its data directory. If you run your
own `tailscale serve` on the same host, CI-Hub leaves that entry in place unless
it uses port 443, which the Hub keeps for its dashboard, or the port of a running
app with **Tailscale** exposure. If `TAILSCALE_SERVE_USER_DISABLED=true` is set,
CI-Hub neither publishes nor removes any Serve entry.

## Turn Private VPN off

Two switches in the hub `.env` turn off different parts of Private VPN. Set either
one to `true` and restart the stack.

| Variable | What it turns off | Read by |
| --- | --- | --- |
| `PRIVATE_VPN_USER_DISABLED` | The `hub-tailscale` sidecar: the CLI leaves the `private-vpn` profile out of `COMPOSE_PROFILES`. The Hub still publishes itself and its Private VPN apps through the host's Tailscale client, if the host has one. | The CLI. The desktop app ignores it and removes the line on its next start, because earlier versions of the desktop app wrote it on their own. |
| `TAILSCALE_SERVE_USER_DISABLED` | Tailscale Serve: the Hub never writes Serve config. It publishes neither its dashboard nor any app, removes nothing it published before, and stops offering **Private VPN** as an app's access option. | The Hub. The desktop app keeps it across restarts. |

Use `PRIVATE_VPN_USER_DISABLED` on a host that runs its own Tailscale client and
does not need the sidecar. Use `TAILSCALE_SERVE_USER_DISABLED` when you manage
the host's Serve config yourself.

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
| **Remote device cannot reach the Hub or apps** | Confirm the remote device is logged in to the same tailnet. With the sidecar, also check that the advertised route in `HUB_TAILSCALE_EXTRA_ARGS` matches the Docker network used by the Hub. |
| **Logs still mention `headscale:8080` after upgrading** | Reconnect Tailscale once so the device state is rewritten against `controlplane.tailscale.com`. If you override `HUB_TAILSCALE_EXTRA_ARGS`, keep an explicit `--login-server=https://controlplane.tailscale.com` unless you intentionally run your own control plane. |
| **App URL works locally but not via Tailscale** | Confirm the Hub and client are on the same tailnet, approve the HTTPS/Serve consent link shown by Hub if needed, then re-save the app with **Tailscale** exposure mode. |
| **A Private VPN app reads "App not responding" but opens from another device on the tailnet** | Run `tailscale serve status` on the host. The app's port must be listed under the device's current name, and its target must be an app that is running. If the port is missing, **Resolve** publishes it again. If the target refuses connections, the app is stopped or still starting, and **Resolve** restarts a stopped container. If the target is a host name, such as `host.docker.internal`, the Hub can't check it, and the message stays even though the app works. |
| **Logs say `serve config denied`** | The Hub uses the host Tailscale client and is neither root nor the host's Tailscale operator. Run the `sudo tailscale set --operator=…` command from the warning once on the host; the next sync publishes the Hub. |
| **Peers fail TLS to the Hub after a device rename** | Wait for the next exposure sync, which runs every five minutes. If peers still fail after that, check the Hub logs for `serve config denied`, or, if `TAILSCALE_SERVE_USER_DISABLED=true` is set, for `Tailscale Serve has no :443 entry` and run the command it names. |
| **Need to turn Tailscale off temporarily** | Set `TAILSCALE_SERVE_USER_DISABLED=true` in the hub `.env` and restart the stack. The Hub then stops publishing to Tailscale Serve but leaves existing entries in place, because other Hubs may reach it through them. It also stops repairing its own entry after a device rename or a `tailscale serve reset`, and only logs a warning, so pool peers lose this Hub until someone publishes it by hand. To remove the Hub's entry, run `sudo tailscale serve --https=443 off` on the host. To stop the sidecar as well, also set `PRIVATE_VPN_USER_DISABLED=true`. |
| **Private VPN app stays Pending, and the log says `Private VPN is turned off for this Hub (PRIVATE_VPN_USER_DISABLED=true)`** | Hub versions starting with 0.2.73 read the sidecar switch as "never write Tailscale Serve config", and the desktop app set that switch on its own. Update the Hub. A Hub that should stay off Tailscale Serve needs `TAILSCALE_SERVE_USER_DISABLED=true` instead. |

## Example operator checklist

Use this short checklist during onboarding or handoff:

- [ ] Device is connected to the correct tailnet
- [ ] **Settings → Network** shows Tailscale as active
- [ ] Hub hostname has been tested from a second device
- [ ] Any private apps that need remote access are set to **Tailscale** exposure mode
- [ ] Auth keys are stored securely and rotated when needed
