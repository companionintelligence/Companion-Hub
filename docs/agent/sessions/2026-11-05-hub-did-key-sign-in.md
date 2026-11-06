# Sign in with a DID (flag-gated)

> **This change touches sign-in. It needs the Hub security reviewer before merge,** and it ships off: nothing is reachable until `CI_HUB_DID_AUTH=true` is set.
>
> The branch has two commits. The first built the feature. The second fixes what an independent adversarial review of the first found: 21 confirmed findings and 2 contested ones (see "Second review"). Where the two disagree, this page describes the second.

## Meta

| Field | Value                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slug  | `hub-did-key-sign-in`                                                                                                                                      |
| Date  | 2026-11-05                                                                                                                                                 |
| Agent | Claude                                                                                                                                                     |
| Model | Sonnet 5.5                                                                                                                                                 |
| Task  | The Hub half of ADR-0016 (Local.Pub alongside KERI): let a person whose identity key is an Ed25519 `did:key` sign in by signing a challenge, as the person who linked that DID first |

## Goal

Add an optional way to sign in with a DID, off by default, without creating a person or a binding from a DID alone, without resolving any DID, without touching forward auth, and without importing or unfreezing the frozen KERI module.

## Steps taken

1. Read `AGENTS.md`, `docs/agent/AGENT_WORKFLOW.md`, `packages/common/src/keri/FROZEN.md`, `docs/security/hub-portal-trust.md`, the `hub-keri-freeze` worksheet, `auth.controller.ts` (login, Portal callback, cookie helpers, rate limiting), `auth.service.ts` (TOTP, `admitHubPerson`), `session.manager.ts`, `forward-auth-identity.resolver.ts`, `federated-identity.repository.ts` and the readers of `federated_identity`.
2. Found that every reader of `federated_identity` that goes through `linksForCurrentPortal` sends a link's subject to Portal as a person id, and that its "every link" fallbacks would return a `did:key` row. Portal answers "not a member" for it, and the check-in sweep and the session refresh both revoke on that answer. Fixed first (see Decisions), with a test that fails without the fix.
3. Wrote `utils/did-key.ts` (Ed25519 `did:key` codec; the same rules and independently produced vectors as Companion Memory's `didKeyId.ts`), `did-auth.service.ts`, `did-auth.guard.ts`, five routes in `AuthController` behind the flag, two rate-limit scopes, DTOs, and the additive helpers they need (`ForwardAuthIdentityResolver.hubIssuer`, `FederatedIdentityRepository.deleteByUserIssuerSubject`, `AuthService.beginTotpStep`).
4. Wrote the tests, then broke seven of the properties on purpose and watched the tests fail.
5. Regenerated `swagger.json` and the frontend API client, and ran the drift gate.
6. **Second commit.** An independent adversarial review of the first commit (five reviewers: token verification, the HTTP stack, shared state, invariants and docs, tests; each finding then checked by two skeptics, a refuter and a reproducer) confirmed 21 findings and left 2 contested. Fixed them on the same branch, without amending the first commit. Details under "Second review".

## Decisions

| Decision | Rationale |
| --- | --- |
| Store a link as a `federated_identity` row, issuer `did:key`, subject the full `did:key:z6Mk…`; no migration | The table is the Hub's existing (issuer, subject) to person binding and already has the unique index. A second table would be a migration for one more `(issuer, subject)` pair. |
| `linksForCurrentPortal` drops every `did:` issuer | Shared table, Portal-assuming readers. Without it a person whose only link is a DID gets asked about at Portal, answered "not a member", and revoked (`reconcileOperatorMemberships`, the session refresh, and `MarketplaceWhoIsService.portalSubject`). A Portal link is never dropped: its issuer is a URL. |
| The proof is a SIOPv2-shaped self-issued ID token | The contract does not depend on a transport. SIOPv2's request-object transport can be added later without changing what the Hub verifies. Whether any Local.Pub client or wallet will sign a Hub challenge is unknown and untested. |
| The audience is `urn:ci-hub:<directory id>` (the issuer forward auth already signs under), not an origin | A Hub is reached under several names (`*.ci.localhost`, a tailnet name, a tunnel); its directory id is the one name it always has. A proof for another Hub or for Portal does not verify. The cost: the anonymous challenge route shows that id (see Open items). |
| The key comes from the DID only; `jwk`, `jku`, `x5u` and `kid` select nothing | Otherwise the token chooses its own verifier. `kid` is allowed only as the DID or `<did>#…`. |
| **Weak Ed25519 keys are not DIDs** (second commit) | A small-order point (order 1, 2, 4 or 8) makes a signature verify for any message with no private key, so a DID for one is a factor nobody has to hold. A `y` of at least 2^255 − 19 is a second spelling of a point, so one key would have two DIDs. `isWeakEd25519Key` refuses all 14 small-order encodings and every such `y` with BigInt arithmetic and no curve library. The five `y` values were produced in Python (RFC 8032 group law) and are re-derived in `did-key.test.ts`. The first commit called these keys "canonical" and listed two of them as valid test vectors. |
| **A challenge has one purpose, `sign-in` or `link`** (second commit) | Without one, a sign-in proof relayed to `/did/link` would bind the signer's DID to the relayer's own person. The purpose is set when the challenge is issued (`POST /did/challenge {purpose}`, default `sign-in`), and a proof presented for the other purpose is refused and the challenge spent. |
| `exp` must be later than `iat` (second commit) | A token that expired before it was issued was accepted inside the clock tolerance. |
| The challenge is deleted on first read, valid proof or not | A failed guess costs a fresh challenge, and a captured proof cannot be tried twice. |
| On `/did/verify`, one 401 body for every verification failure and for a revoked or deleted person; a 403 `AUTH_ERROR_DID_NOT_LINKED` only after the signature verified | The caller learns nothing about which check failed. The 403 is reached only by someone who proved control of the key. |
| **On `/did/link`, a proof that does not verify is a 400, not a 401** (second commit) | The SPA reads any 401 outside `SESSION_EXPIRY_EXEMPT_PATHS` as "your session ended" and signs the person out. `/did/link` is used while signed in, so a wallet that signed wrongly must not end the session. `/api/auth/did/verify` is anonymous and 401 is its answer, so it is on the exempt list. |
| **Every refusal is a `TranslatableError` with an i18n key** (second commit) | The first commit documented and tested `code` fields (`DID_NOT_LINKED` and the rest) that `MainExceptionFilter` drops from a plain `HttpException`: no client ever received one. Every other auth route answers `{statusCode, message, path}` with the key in `message`; these do too, with eight new keys in `en.json` and `en-US.json`. Chosen over changing the filter, which every route shares. |
| **A person with TOTP on still gives the code** (`/did/verify` answers `totpSessionId`) | A deviation from "like Portal SSO". `/auth/portal/callback` creates its session without asking for the Hub's TOTP, and no source records why. A person who turned TOTP on chose a second factor. Cheap, reuses `/auth/verify-totp`, and easy to relax if the reviewer disagrees. (The first commit said "because Portal is the authority there"; that rationale was the author's inference and is gone.) |
| **`/did/verify` makes the session-refresh membership check** (second commit) | The first commit tested only the local `accessStatus`, so a person Portal had just removed could sign in with a linked DID until the next sweep. `AuthService.assertStillOrgMember` (extracted from `refreshSession`, behaviour unchanged) asks Portal for a person with a link from the paired Portal, by that subject: "not a member" revokes and answers 403; a member is marked active. **When Portal cannot be reached, answers with an error, or is not configured, the person is let in**, as the refresh does. A person with no Portal link, and a Hub not paired to an organization, are not asked. It still does not go through `admitHubPerson`. |
| Link, unlink and list need `hubPrincipal === 'session'`. Link and unlink are also refused when the browser says another site sent them, when `Origin` names another host or port than the request's own, and unless the body is JSON (second commit) | The Portal push key, the host-local key and the CLI token all speak as the first operator. `Sec-Fetch-Site` alone does not cover a Hub reached over plain http at a LAN name (a browser sends it only to https and loopback URLs), and a form post is a CORS "simple" request that carries the cookie without a preflight. `Origin` is on every cross-origin POST and DELETE; requiring JSON forces the preflight, which the Hub answers for its own origins only. A request with none of those headers (`curl`, the CLI) passes. The desktop shell's origin is refused until a screen exists. |
| 404 from `DidAuthFlagGuard`, which runs before `AuthGuard`, and it is the 404 Nest gives an unknown path (second commit) | With the flag off the surface is absent for signed-in and anonymous callers alike. The first commit's 404 had its own message and a different `path`, so the two were distinguishable. A test boots a second app without the routes and compares status, body and headers for 31 request shapes as each of four callers (anonymous, a signed-in person, the host-local key, the Portal push key). `AuthController` takes the service as its last, `@Optional()` parameter, so existing tests that build the controller without it keep passing. |
| The DID DTOs are in `SWAGGER_ZOD_DTOS` (second commit) | Unlisted, they generated as empty objects in `swagger.json` and the client, and the drift gate passed because it compares the generator with itself. The generated schemas now carry their properties. |
| Reuse `AuthController`'s private cookie helpers by putting the routes in that file | The Domain and Secure rules for the session cookie are security-sensitive; a copy would drift. The block is delimited (`// ── Sign in with a DID ──`). |
| Did not regenerate `docs/agent/TEST_INVENTORY.md` | As in `hub-keri-freeze`, it is stale at the base and regenerating would pull unrelated rows into this change. |

## Files touched

- `packages/backend/src/modules/auth/`: `utils/did-key.ts`, `did-auth.service.ts`, `did-auth.guard.ts` (new in the first commit; rewritten in the second); `auth.controller.ts` (a delimited block of five routes, one `@Optional()` constructor parameter, imports), `auth.module.ts`, `auth.service.ts` (`beginTotpStep`, `assertStillOrgMember`), `auth-rate-limiter.ts` (`didAuthChallenge`, `didAuth`), `dto/auth.dto.ts`, `forward-auth-identity.resolver.ts` (`hubIssuer`, a public wrapper over the existing private read).
- `packages/backend/src/modules/user/`: `portal-links.ts`, `federated-identity.repository.ts` (`deleteByUserIssuerSubject`).
- `packages/backend/src/swagger-zod-registry.ts`; `packages/common/i18n/translations/en.json` and `en-US.json` (eight `AUTH_ERROR_DID_*` keys each); `packages/frontend/src/lib/session-expiry-policy.ts` (and its test).
- Tests (all in `packages/backend/src/modules/`): `auth/__tests__/did-key.test.ts`, `did-auth.service.test.ts`, `did-auth.controller.test.ts`, `did-auth.guard.test.ts` (new), `did-auth.http.test.ts` (new, the real Nest stack), `did-auth.wiring.test.ts` (new); `forward-auth-identity.resolver.test.ts` (`hubIssuer`), `auth.service.test.ts` (`assertStillOrgMember`); `user/__tests__/federated-identity.repository.test.ts`, `portal-links.test.ts`.
- Generated: `packages/backend/src/swagger.json` and `packages/frontend/src/api-client/*`.
- Docs: `docs/system/backend.md`, `docs/security/hub-portal-trust.md`, this worksheet, `TODO.md`.
- Not touched: `packages/common/src/keri/`, the Traefik header lists, `ForwardAuthIdentityResolver.stableIdFor`, the reserved AID header names, any migration.

## Tests run

Measured after the second commit's changes, in `/home/ci/devel/ci/Companion-Hub.worktrees/did-key-sign-in` (see the report for the exact commands):

- [x] `corepack pnpm --filter backend test`: **461 test files passed, 1 skipped (462); 11619 tests passed, 7 skipped.** The first commit's run was 458 files and 11262 tests.
- [x] The DID files: `did-key` 62, `did-auth.service` 95, `did-auth.controller` 66, `did-auth.guard` 69, `did-auth.http` 197, `did-auth.wiring` 3; `auth.service` 94 (8 new, for `assertStillOrgMember`); `forward-auth-identity.resolver` 20 (7 new, for `hubIssuer`).
- [x] `corepack pnpm exec vitest run --config scripts/vitest.config.ts scripts/__tests__/keri-import-guard.test.ts scripts/__tests__/hub-binding-authority.test.ts`: 2 files, 19 tests passed.
- [x] Frontend `session-expiry-policy.test.ts`, run with the workspace root's vitest and a one-file config (the frontend's own dependencies are not installed): 19 tests passed.
- [x] `corepack pnpm --filter backend run tsc`: exit 0. That project **excludes `**/*.test.ts`**, so no test file is type-checked by the repo; the new and changed test files were checked once with a temporary tsconfig that includes them (clean).
- [x] `corepack pnpm exec biome check --error-on-warnings` on the changed `.ts`/`.json` files (generated files excluded): clean. The repo-wide `lint:ci` was **not** run: it is red at the base for unrelated files.
- [x] `node scripts/check-openapi-drift.cjs`: `openapi drift check passed`. This time the six Did schemas in `swagger.json` carry their properties (before, `"properties": {}`), so the gate is no longer comparing two empty objects.
- [x] `corepack pnpm exec knip --workspace packages/backend`: no findings, exit 0.
- [x] Mutation checks: 86 deliberate breaks of the code under test, each followed by the test files that cover it (a throwaway runner that edits one file, runs vitest, and restores the file byte for byte; it is not committed). **84 were caught** (1 to 99 failing tests each): weak keys (7 of 9), the proof's limits and rules in the service (26), the three guards (11), the route decorators and handler logic (24), the rate limits (3), the membership check (5), `linksForCurrentPortal` (1), `hubIssuer` (2), the module wiring (1), the repository (2), the purpose schema (1) and the SPA exemption (1). Removing a DTO from `SWAGGER_ZOD_DTOS` is caught by `check-openapi-drift.cjs` ("swagger.json is out of date"). **2 were not caught, and cannot be:** dropping the end anchor of the `did:key` shape pattern, and dropping the check of the second multicodec byte. Each is also enforced by a later layer (the base58 decode with the 34-byte length check; the re-encode round trip), so no input tells the mutant from the original.
- [ ] App run (`pnpm run local` / `local:desktop`): **not run.** No Docker or GUI session here.
- [ ] `pnpm run test:integration`, `pnpm run test:entrypoint`, the rest of the frontend tests: **not run.** No Docker/database; frontend dependencies were not installed.
- [ ] `bin/agent-validate-shift`: **not run as one command.** Its first step is `lint:ci`, which is red at the base, and it needs the frontend dependencies. Its component checks above were run separately.

## Second review

An independent review of the first commit found these. "Fixed" means code and a test that fails without it.

| # | Severity | Finding | What was done |
| --- | --- | --- | --- |
| C0 | medium | Small-order and non-canonical Ed25519 keys accepted as DIDs; a proof for one needs no private key | Fixed: `isWeakEd25519Key`; the all-zero and all-0xff keys moved from valid vectors to refused ones; the "canonical" wording in the docs corrected |
| C1 | low | `exp <= iat` accepted | Fixed |
| C2 | low | A sign-in proof could be redeemed as a link | Fixed: challenge purposes |
| C3 | **high** | `POST /did/link` and `DELETE /did/link` could be driven by a same-site page: `Sec-Fetch-Site` is not sent on plain http | Fixed: `Origin` host check, JSON-only, kept `Sec-Fetch-Site`; headerless clients still pass (documented) |
| C4 | medium | A refused proof answered 401, which the SPA treats as a dead session | Fixed: 400 `AUTH_ERROR_DID_PROOF_REFUSED` on link; `/api/auth/did/verify` added to the SPA's exempt list, with a test |
| C5 | medium | Documented `code`s never reached a client; messages were English sentences | Fixed in code: `TranslatableError` with i18n keys; docs list the keys |
| C6, C9 | low | Did DTOs missing from `SWAGGER_ZOD_DTOS`; empty generated schemas | Fixed: registered, swagger and client regenerated, drift check passes with real properties |
| C7 | low | The flag-off 404 differed from Nest's unknown-route 404 | Fixed: same message, `path` and headers; twin-app test |
| C8, C10 | medium | DID sign-in skipped the Portal membership check | Fixed: `assertStillOrgMember`; behaviour when Portal is unreachable (let in) documented; `backend.md` wording corrected |
| C11 | low | "Portal SSO skips TOTP because Portal is the authority" asserted without a source | Docs: observed behaviour only |
| C12 | low | Every recovery path leaves DID links; the operator reset also turns TOTP off; nothing lists or removes a link | Docs, and TODO `did-sign-in-link-surface`. **Not fixed in code**: it needs a decision (see Open items) |
| C13 | medium | Routes tested only by calling controller methods | Fixed: `did-auth.http.test.ts` |
| C14 | medium | `AuthModule`'s `DidAuthService` provider and `hubIssuer()` untested | Fixed: `did-auth.wiring.test.ts`; `hubIssuer` tests |
| C15 | medium | "Never creates a person or a binding" claimed but not asserted | Fixed: asserted in the controller, service and HTTP tests |
| C16 | low | Documented limits not pinned | Fixed: the numbers are literals in the tests (300 s, 30 s, 4096, `#` rule, spend-on-malformed, link rate limit) |
| C17 | low | `did-key` tests decided by one regexp; unreachable branches | Fixed: vectors reach each layer; the re-encode check is documented as a backstop no pattern-matching input reaches |
| C18 | low | Two service tests could not fail for their names | Fixed: a real HMAC test with an honest name; the duplicate removed |
| C19 | low | Flag tests depended on the ambient environment | Fixed: cleared in `beforeEach`/`afterEach` everywhere |
| C20 | low | Repository test never checked the table | Fixed |
| X0 (contested) | low | The anonymous challenge shows the Hub's directory id; `hubIssuer()` called "read-only" though its first call writes | Docs and comment corrected; the disclosure is stated in the trust page |
| X1 (contested) | low | Worksheet and trust page disagreed on whether a signed request object helps against relay | Aligned: it lets a wallet verify and show the Hub's name; it does not stop relay, because the challenge route is public |

A correction to the first commit's wording, from the coordinator's review of the Memory side: the first commit said Local.Pub publishes Ed25519 `did:key`s for its owners, and that was not established. Every sentence in the Hub's code, docs and this worksheet that said or implied it, or that a Local.Pub profile key is what signs in, now says: the Hub accepts any Ed25519 `did:key` that is not weak; a Local.Pub account's DID authentication key (a `z6Mk…` Multikey in its DID log) can be written as a `did:key`, but it can rotate, and a rotation orphans the link; whether any Local.Pub client or wallet will sign a Hub challenge is unknown and untested. This page makes no other claim about what Local.Pub does.

## Open items / handoff

- **Needs the Hub security reviewer before merge** (the change adds a way to obtain a session).
- **Not verified, and not claimed:** no Local.Pub client or wallet has been checked against the token, and none is known to sign one; the Hub was not run end to end; Traefik and Postgres were not in the loop; CI is manual-dispatch, so nothing ran there. The HTTP test runs the real Nest stack with the users, links, cache and Portal faked.
- **Open item: a step-up to link.** Changing the password asks for the current password; linking a DID asks for nothing but a session. A stolen session can link the thief's DID and keep a way in after it ends. Recommended: require the password (or TOTP) to link. A person who only ever signs in through Portal has no local password to ask for, which is why it is not in this change.
- **Open item: what a link outlives.** Changing the password or the username, the operator password reset and a Portal removal all end sessions and leave every DID link, and the operator reset also turns TOTP off, after which `/did/verify` for a linked DID opens a session with no second factor. Nothing but the generated client calls these routes, so no screen or command lists or removes a link (TODO `did-sign-in-link-surface`). Decide whether a password change or an operator reset should list or drop links.
- **Open item: relay.** A person who signs this Hub's challenge on a page an attacker controls hands over a usable proof for up to 120 s, once. The challenge route is public, so the attacker needs nothing from the person's Hub to get a genuine challenge. The audience names this Hub, so a wallet that shows it can warn. A signed SIOPv2 request object lets the wallet verify and show the Hub's name; it does not stop relay. A challenge has one purpose, so a proof relayed for a sign-in cannot be redeemed as a link.
- **Disclosure: the challenge route is anonymous** and returns the Hub's directory id as `audience`. Forward auth already gives apps behind it the same value (`X-CI-Hub-User-Issuer`). The first call can also insert the `user_directory` row after a restore or a reset.
- **Deployment: the `Origin` check compares against the first `X-Forwarded-Host`, else `Host`.** A proxy that rewrites `Host` and sends no `X-Forwarded-Host` makes the Hub's own pages look cross-origin, and their link and unlink calls answer 403. Traefik sends it.
- Rate limits are keyed by client address like the other unauthenticated routes, so behind a proxy the Hub does not vouch for, every caller shares one budget (see `AuthRateLimiter`). Verify and link share one budget of 10 failures a minute.
- The Hub still emits no AID header, builds no `did:keri:` string and does not import the frozen module; `FROZEN.md` and `docs/security/hub-portal-trust.md` still say so truthfully.
- `docs/agent/TEST_INVENTORY.md` was not regenerated (stale at the base).

## Reviews run

| Phase | Persona | Model | Notes |
| ----- | ------- | ----- | ----- |
| Second review | Adversarial: five dimension reviewers, then a refuter and a reproducer per finding | Not recorded here | 21 confirmed, 2 contested, 0 refuted; fixed in the second commit (above). |
| Wrap  | Security | Not run | Run `bin/agent-review --phase wrap --persona security` in a different model's session, and have the Hub security reviewer read `docs/security/hub-portal-trust.md#sign-in-with-a-did`. |
