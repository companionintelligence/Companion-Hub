# Portal check-in and registration health

A registered Hub checks in with Companion Portal to confirm that Portal still accepts its device key. This page covers when the check-in runs, how the Hub reads Portal's answer, how to look at registration health without sending a check-in, and what to do when Portal rejects a Hub.

## When a Hub checks in

The Hub sends `POST /api/devices/check-in` with its device key in `x-device-key`:

- About 10 seconds after boot, then every hour.
- Whenever something reads the live registration status, at most once every 30 seconds. That includes `GET /api/registration/status`, the marketplace routes behind `RegistrationGuard`, the MCP registration tool, app rehydration, and the status report that writes `CI_HUB_STATUS.md`. On the fleet, check-ins landed every 15 minutes, in step with that report.

Each accepted check-in updates the device's `last_seen` in Portal. Portal's organization status report marks a device stale after 3 hours without one.

Reading `GET /api/registration/status` is therefore not a passive observation. It can send a check-in, which changes `last_seen`, and it can change the phase.

## Read registration health without checking in

`GET /api/registration/phase` returns the phase, the degraded reasons, and the outcome of the last check-in this Hub process sent. It reads memory only and never contacts Portal. Like `status`, it needs no authentication.

```json
{
  "phase": "degraded",
  "degradedReasons": ["portal_rejected"],
  "registered": true,
  "lastCheckIn": {
    "at": "2026-09-17T09:15:00.552Z",
    "httpStatus": 401,
    "code": "UNAUTHORIZED",
    "error": "HTTP 401: Invalid Device Key"
  },
  "consecutiveCheckInFailures": 0
}
```

`lastCheckIn` is `null` until the process sends its first check-in, so it is empty for a few seconds after a restart. `httpStatus` is `null` when no response arrived.

`cihub doctor` reads this route and prints two lines:

| Line | Fails doctor when |
| --- | --- |
| `Registration` | The Hub is `degraded` for a reason only pairing clears: `portal_rejected` or `tunnel_token_missing` |
| `Portal check-in` | Never on its own. It shows the HTTP status, Portal's code and error, and how long ago the check-in ran. If Portal refused the device key but the Hub hasn't confirmed the rejection yet, the line says so |

`cloud_validation_failed` and `tunnel_unreachable` are notes, because both can clear without anyone acting.

## How the Hub reads Portal's answer

The rules follow what CI-Portal implements in `deviceAuthMiddleware.ts` and `CheckIn.ts`. The classifier is `packages/backend/src/modules/registration/check-in-response.ts`.

| Portal answer | Cause | Hub response |
| --- | --- | --- |
| `2xx` | Portal accepts the key | Clears `degraded`, if set |
| `401` with a JSON body | No live device holds the key: the device was removed, an owner or admin re-registered it (status `inactive`), or a later pairing rotated the key. Portal also sends this answer when it can't read its device table | A rejection. See below |
| `403` with a JSON `error` | The key belongs to a different `device_id` than the one this Hub resolved | A rejection |
| `400` with code `DEVICE_NOT_ACTIVE` | The device row disappeared after authentication, or Portal couldn't read it | A rejection, and the only one that clears the registration. See below |
| `400` with any other body | Portal refused a field in the check-in body | Transient failure, logged as a schema mismatch |
| Anything else, a non-JSON `401` or `403`, or no response | Portal is unavailable, rate limiting, or something in front of it answered | Transient failure. Three in a row set `cloud_validation_failed` |

`DEVICE_NOT_ACTIVE` is the exception to the wait below. It is coded, it names the device rather than the key, and it is what a person removing this Hub from their account in Portal produces, so the Hub clears its local registration at once and the Settings removal watch reports `removed`. Every other rejection waits.

A rejection sets `degraded` with `portal_rejected` only when Portal is still rejecting the key 10 minutes after the first rejection, with no accepted check-in in between. Until then, each rejection counts as a transient failure, and `lastCheckIn` shows it. The wait exists because CI-Portal's `deviceAuthMiddleware` answers `401 Invalid Device Key` both when no device holds the key and when `DeviceService.findByApiKey` fails to read the database. Without the wait, a short Portal database outage would tell the owner of every Hub that checked in during it to pair again. A removal doesn't clear on its own: the five fleet Hubs described below had been rejected for between one day and a week. At the fleet's 15-minute check-in interval, the second rejected check-in confirms the rejection.

Apart from `DEVICE_NOT_ACTIVE`, a check-in never deletes the registration. The tunnel token authenticates `cloudflared` on its own, and local apps do not need Portal, so deleting the registration over a refused key, or over a body Portal refused, would turn a Portal incident into an outage. A later transient failure doesn't replace `portal_rejected` with `cloud_validation_failed`.

### Pairing a registered Hub again

A Hub in `portal_rejected` or `tunnel_token_missing` accepts a new pairing without a reset. So does a Hub whose key Portal is rejecting but whose rejection isn't confirmed yet. Updating a Hub restarts it, which restarts the 10-minute wait, so the remedy below would otherwise be refused right after the update.

`POST /api/registration/pair` needs no authentication for a Hub that is not registered, because a Hub being set up has nobody to sign in as. To pair a registered Hub again, the caller must be authenticated, the same as for `POST /api/registration/reset`. A Hub session, the host-local device key, and the CLI token all count, and so does a key on a Hub with no operator yet. `cihub register` sends the device key from `state/settings.json`. Without this check, anyone who can reach the Hub could pair it into their own organization, because the Hub sends its own device key to Portal as proof of possession.

The registration callback accepts a pairing for `portal_rejected` and `tunnel_token_missing` only. It carries its own one-time nonce instead of a session.

Earlier builds read these answers differently. They deleted the local registration and tunnel token on any `400`, including a schema refusal, and treated a `401` as transient. A Hub on such a build whose key Portal rejects reports `cloud_validation_failed` after three check-ins and refuses to pair with `Device is already registered.`

## Claimed Hubs degraded with Portal 401

On 2026-09-17, fleet preflight found five claimed Hubs `degraded` with `cloud_validation_failed`, and Portal's entitlement check answered `401` on the same five: core-4, core-14, beta-1, beta-3-glass, and liam-demo. The cause is on the Portal side. Nothing on the Hubs changed when their keys stopped working.

### Evidence

Read-only inspection of Hub, `cloudflared`, and settings files on each node showed the following:

- **The four Bill Co Hubs lost their keys at the same moment.** core-14, beta-1, beta-3-glass, and liam-demo (`hub-core-5-bill-co`) all had accepted check-ins at 05:30 UTC on 2026-09-16 and got `401` at 05:45 UTC.
- **Their tunnels failed in the same window.** Cloudflare's edge dropped the `cloudflared` connections on beta-1 at 05:41:31 UTC, liam-demo at 05:41:47, core-14 at 05:41:49, and beta-3-glass at 05:42:04. Those tunnels have failed to serve since. Keys and tunnels that end together, one device after another, match a removal in Portal, which deletes a device's key and its Cloudflare tunnel.
- **The Hubs kept sending the same credentials.** Each Hub's `settings.json`, which holds the device key, was last written on 2026-09-10 or 2026-09-11. All five Hubs, and the Hubs that pass, use `CI_CLOUD_URL=https://hub.ci.computer`, so none of them switched Portals.
- **Pairing again fixes it.** beta-max, also in Bill Co, lost its key in the same window and paired again at 23:55 UTC on 2026-09-16. Its check-ins pass.
- **core-4 (Hanz Corp) broke earlier.** Its `cloudflared` has logged `Unauthorized: Tunnel not found` since at least 2026-09-08, and its check-in failure counter reached 130 by 2026-09-15. Its device key still matches a backup of `settings.json` from 2026-08-10.
- **Apps did not start.** On core-4, the boot-time start of ci-memory, ci-hermes, ci-openclaw, and ci-import-tools failed on 2026-09-15 with `APP_INSTALL_PORTAL_DOWNLOAD_UNAUTHORIZED`, because the start entitlement check treated the `401` as a refusal. This build starts an installed app when the key is rejected; see [Entitlement checks on start and restart](#entitlement-checks-on-start-and-restart).

### Confirm in Portal

Portal operators can confirm what happened to each device. Each Hub's device ID is in `state/CI_HUB_STATUS.md` on that node.

1. Look up each device ID in the `device` table. Check whether the row exists and whether its `status` is `inactive`.
1. Search Portal Worker logs between 05:40 and 05:45 UTC on 2026-09-16 for `[remove] Device <device ID> removed`, which `DELETE /api/devices/:deviceId` logs on success. That route needs an owner or admin session. For core-4, search before 2026-09-08.
1. Check `audit_log` for `device.re_registered` rows whose `target_id` is one of those device IDs. Removal writes no audit row, so an empty result doesn't rule out a removal.

### Remedy

For each affected Hub:

1. In Portal, as an owner or admin of the Hub's organization, get a pairing code. If the device no longer appears, add it again. If it appears as inactive, re-register it.
1. Update the Hub to a build that includes this change. Otherwise the Hub refuses to pair while it is registered.
1. On the Hub, run `cihub register --code <code>`. It sends the Hub's device key from `state/settings.json`, which authenticates the pairing of an already registered Hub.
1. Run `cihub doctor`. `Registration` shows a ready phase and `Portal check-in` shows `accepted`.

Pairing sends the Hub's current device key as proof of possession. Portal accepts a pairing without that proof only when the device row is `inactive` or absent. If Portal answers `DEVICE_PROOF_REQUIRED`, the row is live under a different key, so re-register the device in Portal and use the new code.

If the device was removed, its tunnel was deleted too. Pairing provisions a new tunnel and hands the Hub its token.

The web UI does not offer pairing for `portal_rejected` yet. Its pairing form and tunnel banner still handle only `tunnel_token_missing`, so use `cihub register`.

## Entitlement checks on start and restart

`MarketplaceEntitlementService` gates marketplace app lifecycle operations on Portal's `GET /api/entitlements/check`. It is a UX cache, not a commerce control. See [Hub ↔ Portal trust](security/hub-portal-trust.md#hub-cache-722--1212).

A restart that a person or an MCP key asks for uses the same policy as Start. Restart runs `docker compose down` and then `up --force-recreate`, so an ungated restart brought back an app that Start refused. `AppLifecycleService.restartApp` checks the policy before the app's status changes to `restarting`. A refused restart returns the error to the caller and leaves the app and its status as they were. If the check ran in the queued command instead, the failure would mark the app `stopped` while its containers kept running.

The Hub's own restarts skip the check. Each of them updates an app that is already running: a credential rotation, a saved config, an inference or custom-domain change, or a Memory key rotation. If Portal refused one of these, the app would keep running with credentials the Hub had already revoked. **Restart all** restarts only running apps, so it can't bring back an app that Start refused.

| Portal answer | Install and update | Start, and a restart a person or key asks for |
| --- | --- | --- |
| Entitled, free, or unknown app | Allowed | Allowed |
| `402` | Refused | Refused |
| `401`: device key rejected | Refused, because the bundle download and registry token that follow need the same key | Allowed, unless a check in the last 24 hours returned `402` |
| Portal unreachable or `5xx` | Allowed only with an entitled answer cached in the last 24 hours | Allowed, unless a check in the last 24 hours returned `402` |

## The push key

Portal pushes to a Hub — an app install brokered through the store — used to authenticate with the
Hub's own Portal device key. That key is also what first-party Companion Memory holds to call
Portal as the device, so accepting it as a Hub operator credential made a compromised Memory
container a Hub operator. The check-in now carries a key the Hub mints for Portal instead
(`PortalPushKeyService`, an ordinary hashed and revocable row in Settings → Security named
"Companion Portal (push)"):

| Field | Direction | Meaning |
| --- | --- | --- |
| `hub_push_key_prefix` | Hub → Portal | Fingerprint of the key this Hub expects Portal to hold. Sent on every check-in. |
| `hub_push_key` | Hub → Portal | The key itself. Sent only until Portal has confirmed holding it. |
| `hub_push_key_prefix` | Portal → Hub | In the `2xx` body: the fingerprint of the key Portal holds for this device, `null` for none, absent from a Portal that predates the exchange. |

Once Portal answers with the Hub's own fingerprint, the Hub records the delivery
(`portalPushKeyDeliveredAt` in `state/settings.json`) and **stops accepting the device key as a
bearer**. Until then it keeps accepting it, so a Hub talking to an older Portal keeps working
exactly as before; the change lands on each Hub the first time its Portal confirms. A revoked row
or a Portal that has lost the key leads to a fresh key on the next check-in, and a registration
reset forgets it entirely.

The host side changed with it: `cihub` on the box (`claim`, `doctor`, `pool`) now presents the
`hubLocalKey` the Hub mints into `state/settings.json` at boot, not the device key.
