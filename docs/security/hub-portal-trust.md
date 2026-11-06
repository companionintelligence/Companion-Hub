# Trust between Companion Hub and Companion Portal

Companion Hub uses the PolyForm Noncommercial License. **Companion Portal** remains a closed-source product. Companion Memory is PolyForm Noncommercial in its own repository. When you review Portal interactions, treat a modified Hub as an **untrusted Portal client**.

Use this page to review the trust boundaries between these products. It is not a penetration test report.

Reviewed against CI-Portal app entitlements ([#639](https://github.com/companionintelligence/CI-Portal/pull/639)) and org grants ([#641](https://github.com/companionintelligence/CI-Portal/pull/641)), Hub entitlement cache ([#1212](https://github.com/companionintelligence/CI-Hub/pull/1212)), and Hub WhoIs ([#1214](https://github.com/companionintelligence/CI-Hub/issues/1214)). GET install device-key auth is merged in [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634).

## Three planes

Do not merge these. A Pro organization is not entitled to every marketplace app, buying an app does not grant Pro, and an org entitlement does not mean every member may install or start that app.

| Plane | What it sells / governs | Source of truth | Stripe |
|---|---|---|---|
| **Platform** | Devices, subdomains, custom domains | `org_plan` / `org_plan_addon`, `EntitlementService` | Checkout and Billing Portal already on Portal. App Checkout **reuses** that Stripe customer and `PaymentProvider.createCheckoutSession` (including saved-card `limited` filters). It is **not** behind `billing.enforcement`. |
| **App commerce** | Marketplace install bundles and private registry images | Org-scoped `app_entitlement` | `metadata.type === 'app'` short-circuits the webhook before platform `intentFor`. 201 from Checkout is a page, not a grant. |
| **Org grants** | Which **member** may do what to which app (Tailscale-shaped ACL) | Org `organization_acl_policy` via Portal WhoIs / CapMap | None. AND with commerce. A kid without `install` gets `GRANT_DENIED`, not ASK_ADMIN. |

Hub never meters usage to Portal. Hub never decides who paid. Hub WhoIs is **not** a till.

## Trust boundaries

| Boundary | Who is trusted | What it covers |
|---|---|---|
| Portal ↔ Hub device | Portal | Pairing, device API key, store install *commands*, GET install bundles, registry JWTs, tunnels, app entitlement checks |
| Hub ↔ apps on the appliance | Hub (local) | Traefik forward-auth headers, memory-connect, wake hooks, local Docker |
| Hub ↔ Memory | Shared appliance secrets | HMAC / connect signing; Memory is PolyForm Noncommercial in CI-Server |

## Device identity

1. During pairing, Portal issues a device credential that Hub stores as `ciHubApiKey`.
2. Hub sends `Authorization: Bearer <ciHubApiKey>` and `x-device-key: <ciHubApiKey>` on outbound Portal calls (`PortalClientService.getDeviceAuthHeaders()`).
3. You can set a local `DEVICE_ID` for diagnostics. **Portal binds the device ID to the issued key.** A forked Hub cannot mint another device's key.

Portal `deviceAuthMiddleware` refuses a missing or unknown `x-device-key` with `401`. Query parameters such as `organizationId` and headers such as `x-device-id` are not identity. The org comes from **device registrations for that key**.

## Org grants (WhoIs)

Portal evaluates grants. Hub caches the CapMap for UX ([#1214](https://github.com/companionintelligence/CI-Hub/issues/1214)). Spec: [CI-Engineering org-app-grants](https://github.com/companionintelligence/CI-Engineering/blob/docs/org-app-grants/projects/org-app-grants/SPEC.md).

- **Identity:** Hub-session operator → their Portal link, the `federated_identity` row whose issuer is the Portal (`subject` is the Portal user id). A row whose issuer is a `did:` method is a DID link, not a Portal link, and is never used here. Device WhoIs is `POST /api/whois` with the appliance `x-device-key` plus that `subject`. Hub has no stored Portal access token and must not take `subject` from the browser.
- **Portal-push vs Hub session:** Portal-pushed installs authenticate as `Bearer ${ciHubApiKey}`. `AuthMiddleware` maps that to the first operator and does **not** set `req.hubSessionId`. Hub evaluates grants only when `hubSessionId` is set. Portal already returned `GRANT_DENIED` on POST install.
- **Unlinked operator:** no Portal link (no `federated_identity` row, or only a `did:` one) → compiled member `HUB_ACTIONS` (not owner `*`) and one `whois_skipped_unlinked_operator` log per userId per process.
- **`organizationId`:** every device WhoIs names this Hub’s `device_registration.id` (the configured organization first). It selects; it is not identity. A Portal with the narrowing ([CI-Portal#734](https://github.com/companionintelligence/CI-Portal/pull/734)) honours it only for one of the device’s current organizations, answers `403 GRANT_DENIED` for any other, and needs it to settle a device whose registrations tie on pairing time (`409 ORGANIZATION_REQUIRED` otherwise). An older Portal ignores it and lists every shared organization, so Hub still picks this Hub’s `device_registration.id` from the answer; do not union.
- **Surfaces:** `hub` for installed list / lifecycle (Portal zeros `can` when not entitled). `store` for catalog search so Buy still shows.
- **Cache:** `(subject, appId) → can[]` plus ACL `version`, 24h TTL like the entitlement cache. Call Portal whenever this Hub’s organization is known; an unreadable or missing registration, like an unreachable Portal, falls back to the cache without asking. Mutating actions fail closed with no fresh cache. Lists fail open so an outage does not empty the house.
- **Hostile Hub:** skip this cache, forge `subject` within orgs the stolen device key belongs to. That is CapMap privacy, not till bypass. GET install and registry stay `app_entitlement`.

Caps header (`X-CI-Hub-Caps`) is spec phase 3, not this Hub path.

## Marketplace install and registry

Two different routes share the `/api/store/:id/install` path:

| Method | Caller | Auth | Role |
|---|---|---|---|
| `POST` | Portal session (person in the store UI) | `sessionMiddleware` plus organization membership over the named device | Portal **pushes** an install command to that Hub. Missing `install` in `can` is 403 `GRANT_DENIED` **before** ASK_ADMIN / Checkout. Owner/admin may pay; members of an unpaid org get `ASK_ADMIN`. An existing org `app_entitlement` skips payment. |
| `GET` | Hub (`downloadAppFiles`) | `deviceAuthMiddleware` (`x-device-key`) — [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634) | Hub **pulls** the install bundle. Free apps (`priceModel === 'free'` only) succeed for a paired device. Paid apps need an **active org entitlement** for an org that device is registered to — not a device-scoped `store_transaction`. |

`GET /api/entitlements/check?appId=&organizationId=` is the same device-key till, used by Hub's local cache. It is not a Hub-trusted claim: Portal re-checks on GET install and on registry mint.

Hub names its organization on the check, the install bundle (query string) and the registry token (JSON body). The name settles which organization is asking and proves nothing. Portal reads it only for a device tied between organizations on its last pairing, and only a member of the tied set is honoured: a tie with no name answers `409 ORGANIZATION_REQUIRED` and a name outside it `403 DEVICE_NOT_IN_ORGANIZATION`. A device in one organization is answered for that organization whatever the name says. A Portal that predates this ignores the name. Hub caches neither refusal as "not entitled": install and update stop with a message saying how to repair it while Start keeps the unreachable policy.

### Registry tokens

`POST /api/devices/registry-token` uses `deviceAuthMiddleware` and **ignores** caller-requested `access` / `repo`.

| Body | JWT |
|---|---|
| none, or no `appId` (Hub sends only `organizationId`) | Pull-only for `ci-hub` (Hub stack listing) |
| `{ appId }` | Pull-only `repos[]` from that app's compose, after an org entitlement check |

Registry `/v2` accepts `payload.repos` (array) or legacy `payload.repo` (string). Tokens without write scope cannot PUT. Repos with a `docker/<repo>/public` marker are readable **without** a JWT. Portal refuses to write those markers for any app whose `priceModel` is not `free` (`PAID_APP_NOT_PUBLIC`).

### If this machine cannot pair

Hub still attempts those Portal calls. Without a stored device key, Portal returns `401`. Marketplace installs do not finish. Registry listing falls back to an empty tag list (`RegistryService.getDeviceRegistryToken`), so the catalog can look **slow or empty** rather than obviously unauthorized. Complete pairing (`cihub register` or the onboarding UI) before you expect store installs to work.

## Capabilities of a modified open-source Hub

Assume the operator controls the appliance: they can patch Hub, skip local checks, and run Docker as they like. They do **not** have Portal signing keys, Stripe webhook secrets, or another customer's `x-device-key`.

| Action | Possible without stolen Portal credentials? | Notes |
|---|---|---|
| Impersonate another paired device at Portal | No | Needs that device's Portal-issued key |
| Impersonate a Portal end-user (OIDC) | No | Hub verifies Portal JWTs via JWKS |
| Download a **free** store install bundle | No | Needs a Portal-issued device key ([#634](https://github.com/companionintelligence/CI-Portal/pull/634)) |
| Download a **paid** store install bundle | No | Key plus an active `app_entitlement` on an org that device is registered to. Client `organizationId` is ignored |
| Skip Hub's local entitlement **cache** | Yes | [Issue #722](https://github.com/companionintelligence/CI-Hub/issues/722) / [#1212](https://github.com/companionintelligence/CI-Hub/pull/1212) is UX. Portal GET install and `/v2` remain the till |
| Skip Hub's local WhoIs **cache** | Yes | [#1214](https://github.com/companionintelligence/CI-Hub/issues/1214) is UX. Portal POST install `GRANT_DENIED` and `app_entitlement` remain the gates |
| Widen a registry JWT | No | Mint ignores client `access`/`repo`; Hub-stack token is `ci-hub` only; app tokens are `repos[]` after entitlement |
| Pull a **public-marked** image with no JWT | Yes, if a marker exists | Portal must not mark paid repos public. A mis-marked paid repo is pullable by any Hub |
| Pull a **private** paid image | No, without an entitled JWT | Hub does not yet `docker login` with the per-app JWT, so an **entitled** private pull may still fail at compose — a product gap, not a fail-open |
| Open app Checkout or grant `app_entitlement` | No | Session + owner/admin; webhook HMAC; Hub is not on that path |
| Forge Stripe webhooks | No | Portal verifies Stripe signatures |
| Bill from Hub-reported metering | No | Not implemented, and must not be |
| Run arbitrary local Docker apps | Yes | Appliance control plane is local. Unsigned compose is not a Portal entitlement |
| Forge Traefik forward-auth identity for apps on this appliance | Yes | Whoever controls Hub and `CI_HUB_FORWARD_AUTH_SECRET` (or the per-app secret) can mint `X-CI-Hub-User`. That trust is **appliance-local**, not Portal authority |

## Hub cache (#722 / #1212)

`MarketplaceEntitlementService` caches Portal `/api/entitlements/check` for 24h. The cache has no organization column, so a reset or a pair into another organization empties it.

- **Install / update:** fail closed if Portal is unreachable and there is no fresh entitled cache.
- **Start / restart:** best-effort so an already-installed app can come up when Portal is down, unless a fresh cache says not entitled. A restart a person or MCP key asks for shares Start's policy, checked before the status changes. The Hub's own restarts (credential rotation, config, inference, custom-domain) are not gated, because a refused one leaves the app running on revoked credentials.
- **404 / free:** skip (local or unsigned apps still run).
- **402:** `APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED`.
- **401:** install and update refuse with the existing unauthorized string. Start and restart use the unreachable policy, because a rejected device key is not an entitlement decision. See [`portal-check-in.md`](../portal-check-in.md#entitlement-checks-on-start-and-restart).
- **409 `ORGANIZATION_REQUIRED` / 403 `DEVICE_NOT_IN_ORGANIZATION`:** install and update refuse with a message saying how to repair it, even on a fresh entitled cache. Start and restart use the unreachable policy. Neither is cached.

Skipping or forging this cache cannot download a paid bundle or mint an app registry JWT.

## Memory-connect and wake

- Require a Hub session for browser memory-connect (`AuthGuard`).
- Bind managed app keys to an app URN. Don't treat internal-network IP allowlists as the security boundary.
- Keep agent wake and notify operations on the appliance (Hub → app wake hooks). These operations don't grant Portal marketplace rights.

## Forward-auth is appliance-local

Traefik `forwardauth` calls Hub `/api/auth/traefik`. On a valid Hub session, Hub returns HMAC-signed `X-CI-Hub-User` headers for **apps on that appliance**. Those headers are not a Portal session and must not be treated as one. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) (forward auth) and [`adr/002-sibling-public-hostnames-edge-sso.md`](../adr/002-sibling-public-hostnames-edge-sso.md).

Each app's headers are signed with that app's own key, read from its `app.env`:

- An app with `CI_HUB_FORWARD_AUTH_SECRET` gets the username, timestamp, and stable id signed with it, plus `X-CI-Hub-User-Assertion: 2.<nonce>.<hex>`, an HMAC under its own key over `ci-hub-forward-auth/2\n<app urn>\n<nonce>\n<timestampMs>\n<username>\n<issuer>\n<user id>`. The assertion names the app it was signed for, and the nonce is fresh per request.
- Companion Memory's `CI_HUB_FORWARD_AUTH_SECRET` is the Hub-wide secret, because it also authenticates the connect exchange and the agent doorbell. Its own key is `CI_HUB_FORWARD_AUTH_IDENTITY_SECRET`, written with `CI_APP_URN` (its audience). The username triple is still signed with the Hub-wide secret for Memory releases that predate the assertion.
- An app with no key (every third-party app), or a host that matches no installed app, gets `X-CI-Hub-User` alone, unsigned. Such an app cannot check a signature, and the Hub-wide secret never stands in for a missing key.
- The Hub produces no AID header. `X-CI-Hub-User-AID`, `X-CI-Hub-AID`, and `X-CI-Hub-KEL-Digest` are reserved names, and an app must ignore them. On a route that uses the `ci-hub` forward-auth middleware, with the current header list, Traefik deletes a visitor's own copy of each, so an app behind it does not receive a value. That has not been exercised against a running Traefik, and an existing install gets the longer list only when its compose or dynamic file is rewritten. The stable id that forward auth signs is the issuer and the person's id, with nothing derived from them. The in-tree KERI module is frozen and not interoperable; see [`FROZEN.md`](../../packages/common/src/keri/FROZEN.md).

## Identity bindings

The Hub is a client of Portal and of the box, never a source of identity bindings. Portal decides which person owns a computer, and the box records it. The Hub has no route, table, or module that reads, writes, or names that record: no file under `packages/` carries its file name, its service name, its client's name, or its state folder, and `scripts/__tests__/hub-binding-authority.test.ts` fails if one does.

Treat that as a property of the code, not as a security boundary. The Hub controls Docker on the appliance, so a Hub compromise reaches root, and the box has to defend its own record.

## Sign in with a DID

An optional second way into the Hub, **off unless `CI_HUB_DID_AUTH=true`** (every route answers the 404 of a route that does not exist otherwise). The Hub reads the flag from the environment of its own process, on every request; nothing in a running Hub changes that environment, so switching the feature off takes a restart or a recreated container. The routes, the token and the rules are in [the backend system doc](../system/backend.md#sign-in-with-a-did); this section is what it asks the Hub to trust. It is the Hub half of ADR-0016 (Local.Pub alongside KERI), and it needs the Hub security reviewer before it merges.

The Hub accepts any well-formed Ed25519 `did:key` that is not a weak key, and says nothing about who can produce one. A Local.Pub account's DID authentication key (a `z6Mk…` Multikey in its DID log) can be written as a `did:key`, but it can rotate, and a rotation orphans the link. Whether any Local.Pub client or wallet will sign a Hub challenge is unknown and untested.

| Question | Answer |
|---|---|
| What does the Hub trust? | That whoever signed the challenge holds the private key of the `did:key` it names, and that a signed-in Hub person linked that DID earlier. The verifying key is derived from the DID alone. A key that would verify without a private key (a small-order point, or a second spelling of a point) is not a `did:key` to the Hub, and neither is a string of bytes that is not a point on the curve. |
| What does it not trust? | Local.Pub, Portal, any DID registry or resolver, any header in the token. The Hub makes **no network call** to verify a proof. A DID method whose key can rotate is refused, not resolved. |
| Is the Hub a source of identity bindings here? | No. It is a login method, like a Portal link: a `federated_identity` row (issuer `did:key`) that a signed-in person made for themselves. It is not the box's record of which person owns the computer, which the Hub still neither reads nor writes (above). The Hub never creates a person, or a binding, from a DID alone. |
| Which factor is it? | Possession of a key. It replaces the password, **not the second factor**: a person with TOTP on still gives the code (`/did/verify` answers `totpSessionId`). The Portal sign-in routes (`/auth/portal/callback`, and the mobile and desktop session routes) create their sessions without asking for the Hub's TOTP, and no source records why; this path does not copy that. |
| Is Portal asked whether the person is still a member? | For a person with a Portal link, yes, as the session refresh does (`AuthService.assertStillOrgMember`, by the Portal subject, never the DID): "not a member" revokes them and answers 403. That includes a person whose only Portal link is from another Portal, who is asked about it and revoked on a definitive "not a member", as the sweep and the refresh have always done (#2178). It does not go through `admitHubPerson`, the path password and Portal SSO sign-in take. **When Portal cannot be reached, answers with an error, or is not configured, the person is let in**, and so when the registration cannot be read. A person with no Portal link at all, and a Hub not paired to an organization, are not asked, and an unpaired Hub never revokes anyone. |
| Who can link or unlink? | An interactive Hub session only, and only from the Hub's own pages. The Portal push key, the host-local key and the CLI token, which all speak as the first operator, are refused. So is a request a browser says another site sent (`Sec-Fetch-Site`), one whose `Origin` names another host or port than the one it was sent to, and one whose body is not JSON, because a form post reaches the Hub with the cookie and no preflight. A request with none of those headers (`curl`, the CLI) passes. The shared demo user cannot link or unlink in demo mode. The desktop shell's origin is another origin and is refused until a screen exists. |
| What does a stolen session buy? | The ability to link the thief's own DID and keep a way in after the session ends. Changing the password or the username, the operator password reset and a Portal removal all end sessions and **leave every DID link**, and the operator reset also turns TOTP off, after which `/did/verify` signs the linked DID in with no second factor. Nothing but the generated API client calls these routes, so no screen or command lists or removes a link. Changing the password asks for the current password; linking a DID does not. **Open items for the reviewer:** require the password (or TOTP) to link; add a list and remove surface; decide whether a password change or an operator reset should list or drop links. |
| What does a lost or stolen key buy, and what does unlinking it do? | A key that was linked signs in as its person for as long as the row exists, with the TOTP step if the person has TOTP and nothing else. Unlinking removes the row and **ends no session**: a session the key already opened is an ordinary seven-day session that slides, and only a password or username change (or a revocation) ends it. With no screen or command that lists links, the owner cannot even see which keys are linked. **Open item for the reviewer:** whether an unlink should end the person's other sessions (`did-sign-in-link-surface`). |
| Can a proof be relayed? | Yes, as with any challenge-response sign-in: a person asked to sign this Hub's challenge on a page the attacker controls hands the attacker a proof, if the attacker presents it before the challenge expires (120 s, once). The challenge route is public, so the attacker needs nothing from the person's Hub or session to get a genuine challenge. The audience names this Hub, so a wallet that shows it lets the person see where they are signing in. A signed SIOPv2 request object would let the wallet verify and show the Hub's name; it would not stop relay. **The purpose does not stop a relayer.** A challenge has a purpose, `sign-in` or `link`, and a proof for the other purpose is refused, but the purpose is chosen by whoever requests the challenge, which is the relayer, and it is not signed, so the signer's wallet never sees it. A relayer who asks for a `link` challenge, shows it as a login, and redeems the signature on `/did/link` from their own session plants the signer's DID on the relayer's person: the signer's own link then fails with a 409, they cannot remove a row that is not theirs, and their DID signs in as the relayer's person. **Open items for the reviewer:** a signed purpose or request object, and a way for the holder of a DID key to release a link someone else made (`did-sign-in-signed-purpose`, `did-sign-in-release-link`). |
| What does the challenge route show? | It is anonymous, so with the flag on any caller who can reach the Hub, a tunnel or a public hostname included, learns its directory id as the audience: a per-install identifier that lasts until a factory reset. Forward auth gives that value (`X-CI-Hub-User-Issuer`) only to apps that hold a forward-auth key, which are Companion Memory and any app whose env sets its own `CI_HUB_FORWARD_AUTH_SECRET`; an app without a key, which is every third-party app, gets the username alone (above). So this is a **new disclosure** of a stable per-install id, not a repeat of what apps already see. **Open item for the reviewer:** accept it, or ask for an audience that does not carry the directory id. The first call can also write: it inserts the `user_directory` row when a restore or a reset left none, as the first forward-auth call does. |
| What did not change? | Forward auth. `X-CI-Hub-User-AID`, `X-CI-Hub-AID` and `X-CI-Hub-KEL-Digest` are still never set, no `did:keri:` string is built, and the frozen KERI module is still not imported. |

A DID link sits in the same table as Portal links, and Portal-facing code sends a link's subject to Portal as a person id. `linksForCurrentPortal` therefore drops every link whose issuer is a `did:` method; without that, a person whose only link was a DID could be asked about at Portal, answered "not a member", and revoked.

**Not verified:** no Local.Pub client or wallet has been checked against the token, and none is known to sign one; the Hub was not run end to end, and no Traefik or Postgres was in the loop. The HTTP test runs the real Nest stack with the users, links, cache and Portal faked.

## Review checklist for publication

- [x] Registry-token: Portal rejects a missing or invalid `x-device-key` (`MintRegistryToken` + `deviceAuthMiddleware`; covered by Portal tests).
- [x] GET install bundle: Portal rejects a missing or invalid `x-device-key` ([CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634), merged).
- [x] Paid GET install is an **org** `app_entitlement`, not a device `store_transaction`. Query `organizationId` is not identity ([CI-Portal#639](https://github.com/companionintelligence/CI-Portal/pull/639)).
- [x] Portal does not treat Hub-reported entitlement claims as authoritative on POST install (session + membership + entitlement/payment).
- [x] Paid apps cannot receive `docker/<repo>/public` markers (`PAID_APP_NOT_PUBLIC` on publish and visibility).
- [x] App Checkout reuses the org's platform Stripe customer and the same `PaymentProvider` Checkout snippet as custom domains / Pro. Planes stay separate (`metadata.type === 'app'`).
- [x] Hub entitlement cache is documented as UX, not a till ([#1212](https://github.com/companionintelligence/CI-Hub/pull/1212)).
- [x] Hub WhoIs / org grants cache is documented as UX, not a till ([#1214](https://github.com/companionintelligence/CI-Hub/issues/1214)). Device WhoIs uses federated `subject`; Portal-push skips Hub grants.
- [x] Forward-auth documentation states Hub-signed headers apply only to apps on that appliance (this page + architecture).
- [ ] Sign in with a DID (off by default): the Hub security reviewer has read [the rules](../system/backend.md#sign-in-with-a-did) and decided the open items above (a step-up to link, a list and remove surface, what a password change, an operator reset or an unlink does to links and sessions, a signed purpose and a way to release a planted link, the directory id the challenge route shows) before it is switched on anywhere.
- [x] Portal remains closed-source. Memory is PolyForm Noncommercial in CI-Server; the Hub license does not relicense Portal ([License FAQ](../License-FAQ.md)).
