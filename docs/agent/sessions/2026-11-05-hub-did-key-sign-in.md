# Sign in with a DID (flag-gated)

> **This change touches sign-in. It needs the Hub security reviewer before merge,** and it ships off: nothing is reachable until `CI_HUB_DID_AUTH=true` is set.

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
3. Wrote `utils/did-key.ts` (canonical Ed25519 `did:key` codec; the same rules and independently produced vectors as Companion Memory's `didKeyId.ts`), `did-auth.service.ts`, `did-auth.guard.ts`, five routes in `AuthController` behind the flag, two rate-limit scopes, DTOs, and the additive helpers they need (`ForwardAuthIdentityResolver.hubIssuer`, `FederatedIdentityRepository.deleteByUserIssuerSubject`, `AuthService.beginTotpStep`).
4. Wrote the tests, then broke seven of the properties on purpose and watched the tests fail (below).
5. Regenerated `swagger.json` and the frontend API client, and ran the drift gate.

## Decisions

| Decision | Rationale |
| --- | --- |
| Store a link as a `federated_identity` row, issuer `did:key`, subject the full `did:key:z6Mk…`; no migration | The table is the Hub's existing (issuer, subject) to person binding and already has the unique index. A second table would be a migration for one more `(issuer, subject)` pair. |
| `linksForCurrentPortal` drops every `did:` issuer | Shared table, Portal-assuming readers. Without it a person whose only link is a DID gets asked about at Portal, answered "not a member", and revoked (`reconcileOperatorMemberships`, the session refresh at `auth.service.ts` ~1014, and `MarketplaceWhoIsService.portalSubject`). A Portal link is never dropped: its issuer is a URL. |
| The proof is a SIOPv2-shaped self-issued ID token | The contract does not depend on a transport. SIOPv2's request-object transport can be added later without changing what the Hub verifies. Nothing produces this token for a Hub audience today. |
| The audience is `urn:ci-hub:<directory id>` (the issuer forward auth already signs under), not an origin | A Hub is reached under several names (`*.ci.localhost`, a tailnet name, a tunnel); its directory id is the one name it always has. A proof for another Hub or for Portal does not verify. |
| The key comes from the DID only; `jwk`, `jku`, `x5u` and `kid` select nothing | Otherwise the token chooses its own verifier. `kid` is allowed only as the DID or `<did>#…`. |
| The challenge is deleted on first read, valid proof or not | A failed guess costs a fresh challenge, and a captured proof cannot be tried twice. |
| One 401 body for every verification failure and for a revoked or deleted person; a 403 `DID_NOT_LINKED` only after the signature verified | The caller learns nothing about which check failed. The 403 is reached only by someone who proved control of the key. |
| **A person with TOTP on still gives the code** (`/did/verify` answers `totpSessionId`) | A deviation from "like Portal SSO". `/auth/portal/callback` creates the session directly and never asks for the Hub's TOTP, because Portal is the authority there. A DID has no remote authority, and a person who turned TOTP on chose a second factor. Cheap, reuses `/auth/verify-totp`, and easy to relax if the reviewer disagrees. |
| Link, unlink and list need `hubPrincipal === 'session'`; a change is also refused when `Sec-Fetch-Site` is `same-site` or `cross-site` | The Portal push key, the host-local key and the CLI token all speak as the first operator. The cross-site test is the one `registration.controller.ts` already applies to session callers. |
| 404 from `DidAuthFlagGuard`, which runs before `AuthGuard`; `AuthController` takes the service as its last, `@Optional()` parameter | With the flag off the surface is absent for signed-in and anonymous callers alike, and existing tests that build the controller without the service keep passing. |
| Reuse `AuthController`'s private cookie helpers by putting the routes in that file | The Domain and Secure rules for the session cookie are security-sensitive; a copy would drift. The block is delimited (`// ── Sign in with a DID ──`). |
| Did not regenerate `docs/agent/TEST_INVENTORY.md` | As in `hub-keri-freeze`, it is stale at the base and regenerating would pull unrelated rows into this change. |

## Files touched

- `packages/backend/src/modules/auth/`: `utils/did-key.ts`, `did-auth.service.ts`, `did-auth.guard.ts` (new); `auth.controller.ts` (a delimited block of five routes, one `@Optional()` constructor parameter, imports), `auth.module.ts`, `auth.service.ts` (`beginTotpStep`), `auth-rate-limiter.ts` (`didAuthChallenge`, `didAuth`), `dto/auth.dto.ts`, `forward-auth-identity.resolver.ts` (`hubIssuer`, a public wrapper over the existing private read).
- `packages/backend/src/modules/user/`: `portal-links.ts`, `federated-identity.repository.ts` (`deleteByUserIssuerSubject`).
- Tests: `__tests__/did-key.test.ts` (39), `__tests__/did-auth.service.test.ts` (73), `__tests__/did-auth.controller.test.ts` (39) and, in `modules/user/__tests__/`, `federated-identity.repository.test.ts` (3, new); `portal-links.test.ts` (+4) and `auth.service.test.ts` (+1) extended.
- Generated: `packages/backend/src/swagger.json` (+153 lines, no removals) and `packages/frontend/src/api-client/*` (four files).
- Docs: `docs/system/backend.md`, `docs/security/hub-portal-trust.md`, this worksheet, `TODO.md`.
- Not touched: `packages/common/src/keri/`, the Traefik header lists, `ForwardAuthIdentityResolver.stableIdFor`, the reserved AID header names, any migration.

## Tests run

- [x] `corepack pnpm exec biome check --error-on-warnings` on the 17 changed `.ts` files: clean, exit 0. The repo-wide `lint:ci` was **not** run: it is red at the base for unrelated files (`hub-keri-freeze` measured 143 files with diagnostics) and was not re-measured here.
- [x] `corepack pnpm --filter backend run tsc`: exit 0 (TypeScript 7.0.2, after building `@ci-hub/common`'s types). An injected type error in a new file was reported, so the check does read the new files.
- [x] `corepack pnpm --filter backend test`: **458 test files passed, 1 skipped; 11262 tests passed, 7 skipped.**
- [x] The six files this change adds to or extends: 251 tests, 0 failed.
- [x] `corepack pnpm exec vitest run --config scripts/vitest.config.ts scripts/__tests__/keri-import-guard.test.ts scripts/__tests__/hub-binding-authority.test.ts`: 2 files, 19 tests passed.
- [x] `node scripts/check-openapi-drift.cjs`: `openapi drift check passed` (it regenerates `swagger.json` and the client and compares).
- [x] `corepack pnpm exec knip --workspace packages/backend`: no findings, exit 0. The repo-wide `knip:ci` exits 2 here for six unused files, four unused dependencies and `Cannot find module '@react-router/dev/…'` errors, all in `packages/frontend` and `packages/mobile`: their dependencies were not installed in this environment, and none of it names a file this change touches. It was not compared against the base.
- [x] Mutation checks: each of these was broken on purpose and the tests failed, then the code was restored and all 124 tests of the three files passed again: link/unlink accepting any principal (5 tests failed); a revoked person let in (1); a cross-site change allowed (2); the challenge not deleted on read (3); the nonce not compared (2); `sub` not bound to the DID (1); `linksForCurrentPortal` keeping DID links (3).
- [ ] App run (`pnpm run local` / `local:desktop`): **not run.** No Docker or GUI session here.
- [ ] `pnpm run test:integration`, `pnpm run test:entrypoint`, the frontend tests: **not run.** No Docker/database; frontend dependencies were not installed.
- [ ] `bin/agent-validate-shift`: **not run as one command.** Its first step is `lint:ci`, which is red at the base, and it needs the frontend dependencies. Its component checks above were run separately.

## Open items / handoff

- **Needs the Hub security reviewer before merge** (the change adds a way to obtain a session).
- **Not verified, and not claimed:** this was never run against a real Local.Pub account (invite-only; nobody here can create one); **no wallet or Local.Pub client produces this token for a Hub audience yet**, so no real signer has ever been checked against it; the Hub was not run end to end; Traefik is not in the loop; CI is manual-dispatch, so nothing ran there.
- **Open item: a step-up to link.** Changing the password asks for the current password; linking a DID asks for nothing but a session. A stolen session can link the thief's DID and keep a way in after it ends ("sign out everywhere" does not remove links). Recommended: require the password (or TOTP) to link. A person who only ever signed in through Portal has no local password to ask for, which is why it is not in this change.
- **Open item: relay.** A person who signs this Hub's challenge on a page an attacker controls hands over a usable proof for up to 120 s, once. The audience names this Hub, so a wallet that shows it can warn. A signed SIOPv2 request object would help.
- Rate limits are keyed by client address like the other unauthenticated routes, so behind a proxy the Hub does not vouch for, every caller shares one budget (see `AuthRateLimiter`).
- The Hub still emits no AID header, builds no `did:keri:` string and does not import the frozen module; `FROZEN.md` and `docs/security/hub-portal-trust.md` still say so truthfully.
- `docs/agent/TEST_INVENTORY.md` was not regenerated (stale at the base).

## Reviews run

| Phase | Persona | Model | Notes |
| ----- | ------- | ----- | ----- |
| Wrap  | Security | Not run | Run `bin/agent-review --phase wrap --persona security` in a different model's session, and have the Hub security reviewer read `docs/security/hub-portal-trust.md#sign-in-with-a-did`. |
