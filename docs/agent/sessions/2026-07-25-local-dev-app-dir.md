# Session Worksheet Template

> Copy to `docs/agent/sessions/YYYY-MM-DD-<slug>.md` and commit with your work.
> Git tag after merge: `agent-session/<slug>`

---

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `local-dev-app-dir` |
| **Date** | 2026-07-25 |
| **Agent** | Claude |
| **Model** | Claude Sonnet 5 |
| **Task** | User request: source-based `pnpm run local` dev stack couldn't get Cloudflare Tunnel working (EACCES on `/app`, wrong compose-file path for the `cloudflared` container auto-start) |

---

## Goal

Fix `ensureLocalDevRuntimeEnv()` (source-based local dev startup) so it remaps `CI_HUB_APP_DIR` to the checkout root the same way it already remaps `CI_HUB_DATA_DIR`/`CI_HUB_APP_DATA_DIR`/`CI_HUB_APP_DATA_PATH`, since the backend's `/app` default doesn't exist when it runs bare on the host.

---

## Steps taken

1. Ran `cihub up local`, hit `EACCES: permission denied, mkdir '/app'` when the Hub tried to write Cloudflare tunnel credentials.
2. Traced it to `CloudflareClientService` deriving `TUNNEL_DIR` from `APP_DIR` (`packages/backend/src/common/constants.ts`), which defaults to `/app` — the packaged container's root, nonexistent in source-based local dev.
3. First attempted a `.env.local`-only override (`CI_HUB_TUNNEL_DIR`); discovered it never reaches the backend process because `turbo.json`'s `local`/`dev` task `env` allowlist doesn't include it (Turborepo filters env vars per task).
4. Switched to `CI_HUB_APP_DIR`, which **is** allowlisted in `turbo.json` and is the actual root cause var — also fixes a second bug: `CloudflareClientService#getComposeFile()` falls back to `path.join(APP_DIR, filename)` when no mounted compose file is found, so it was shelling out to `docker compose -f /app/docker-compose.local.yml ...` (nonexistent path) to auto-start the `cloudflared` container.
5. Verified via a manual `.env.local` override end-to-end (tunnel token written, `cloudflared` container started, public app URLs returned 200 after also standing up a manual `traefik` container to bridge a separate, out-of-scope gap: local dev has no Traefik service at all, and the Hub's own generated dynamic config already expects one).
6. Implemented the real fix in `ensureLocalDevRuntimeEnv()` (`scripts/cihub-cli.ts`): default `CI_HUB_APP_DIR` to `process.cwd()` (verified `requireRepoRoot()` already guarantees cwd = checkout root at this call site). Exported the function (previously unexported) for testability, matching existing patterns in the file.
7. Removed the manual `.env.local` override and re-ran via `pnpm run local` (the `tsx`-run TS source path — `bin/cihub` is a separately-built standalone binary that would NOT have picked up the source change) to confirm the fix works with zero manual config.
8. Added two unit tests in `scripts/__tests__/cihub-cli.test.ts`.
9. Ran `bin/agent-validate-shift --skip-visual --skip-benchmark` — all steps passed.
10. Ran cross-agent review (`bin/agent-review --phase wrap`, personas `code-quality` and `security`) via two independent subagent invocations (`bin/agent-review` itself only prints a prompt for a separate agent session — no MCP-connected reviewer available, so this was fulfilled via the Agent tool instead).
11. Applied the code-quality reviewer's one suggestion (symmetric file-content assertion in the second test).
12. Verified and documented the security reviewer's one Warning finding (below) with an inline code comment rather than changing the value — the narrower alternatives considered would break the compose-file-path fix, which needs `APP_DIR` to be the *real* checkout root.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use `CI_HUB_APP_DIR`, not `CI_HUB_TUNNEL_DIR` | Not turbo-allowlisted for the `local`/`dev` tasks; never reaches the backend process regardless of what's in `.env.local`. `CI_HUB_APP_DIR` is allowlisted and also fixes the compose-file-path bug in the same pass. |
| Default to `process.cwd()`, not a synthetic path under `.internal/` | `getComposeFile()`'s fallback needs `APP_DIR` to resolve to a directory where `docker-compose.local.yml` (and its `./tunnel` relative bind mount) actually exist — that's only true at the real checkout root. |
| Did not add a `traefik` service to `docker-compose.local.yml` | Bigger, more opinionated scope (Traefik-in-local-dev + the Hub's own public route needs a literal `ci-os-hub` container that doesn't exist in source dev either way). Flagged to the user as a separate follow-up, not bundled into this PR. |
| Accepted the `getSafeFilePath` allowlist widening (security review finding) rather than narrowing `APP_DIR` | No narrower value satisfies both bugs this PR fixes. Gated entirely behind `requireRepoRoot()`/`isApplianceMode()`, so it never reaches packaged/appliance/prod/staging/dev-docker; a local dev already has equal-or-greater direct filesystem access. Documented inline instead. |

---

## Files touched

- `scripts/cihub-cli.ts` — `ensureLocalDevRuntimeEnv()`: export + `CI_HUB_APP_DIR` default
- `scripts/__tests__/cihub-cli.test.ts` — new `describe('ensureLocalDevRuntimeEnv', ...)` block, 2 tests

---

## Tests run

- [x] `pnpm run lint:ci`
- [x] `pnpm run tsc` (via `bin/agent-validate-shift`)
- [x] `pnpm test` (via `bin/agent-validate-shift` — 2012 backend + 722 frontend + 274 CLI tests passed)
- [x] App run (`pnpm run local`) — verified end-to-end with zero manual `.env.local` overrides: tunnel token written, `cloudflared` container auto-started, no `EACCES`
- [x] `bin/agent-validate-shift`

---

## Open items / handoff

- **Not fixed / out of scope**: `docker-compose.local.yml` has no `traefik` service, so Cloudflare Tunnel routing to installed marketplace apps still requires manually running a standalone `traefik` container (done ad hoc for this session, not committed anywhere). The Hub's own public route (`hub-<device>-<user>.companionintelligence.com`) additionally needs a container literally named `ci-os-hub`, which doesn't exist in source-based local dev — that route will keep 502ing regardless. User was informed and did not ask for this to be pursued in this PR.
- If a future change wants full Cloudflare Tunnel app-routing support in local dev, it needs a real decision on whether/how to run Traefik there (new compose service vs. something else) — flagged as a candidate `TODO.md` item, not added since no maintainer sign-off yet.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| wrap | code-quality | Claude (general-purpose subagent) | Clean; 1 suggestion (symmetric test assertion) — applied |
| wrap | security | Claude (general-purpose subagent) | 1 Warning (`getSafeFilePath` APP_DIR allowlist now covers full checkout in local dev) — accepted tradeoff, documented inline; 1 non-blocking suggestion (tunnel token now persists where it silently never did before — no new leak vector, pre-existing 0o644 mode, gitignored) |
