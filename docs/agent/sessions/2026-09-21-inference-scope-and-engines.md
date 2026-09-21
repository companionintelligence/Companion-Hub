# Session Worksheet — inference scope, pooled listing, two more engines

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `inference-scope-and-engines` |
| **Date** | 2026-09-21 |
| **Agent** | Claude |
| **Model** | Opus 5 |
| **Task** | User request: close the gaps found by comparing Hub to `yoel3imari/llm-advisor` and `autonomous-ai/autonomous-grid`, and add more backend engine support |

---

## Goal

Two external projects were compared against Hub. Both lead with the same headline — "point your
editor at this endpoint" — and Hub had the better router behind a door that did not open. AI Grid
additionally had two things Hub lacked: a model listing that answers for the whole grid, and the
ability to use an engine the operator already runs. This session closed those three, and left
training (GRPO/LoRA) and pool-routed media generation untouched as genuinely out of scope.

---

## Steps taken

1. Read `AGENTS.md`, `AGENT_WORKFLOW.md`, `TODO.md` (empty), and `docs/system/backend.md`.
2. Traced the existing `qa:read` scope end to end as the precedent for a new one.
3. Added the `inference` scope: middleware arm, route allow-list, guard admissions, DTO, CLI, UI.
4. Merged peer inventories into the two pooled listing endpoints.
5. Added the `llamacpp` and `lmstudio` backends and followed the compiler to every wiring site.
6. Fixed the fixtures and hand-counted assertions the new backend types exposed.
7. Full test + typecheck sweep after each slice; three commits.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| The middleware lookup IS the allow-list for `inference`, not a decorator | `AuthMiddleware` runs before Nest resolves a handler, so it cannot read handler metadata the way `ObservabilityReadGuard` reads `@ObservabilityRead()`. Gating the lookup is also stronger: off-path the principal is never named, so no guard can be talked into honouring it. |
| `/api/inference/pool/local/*` excluded from that list | Every pooled turn crosses it, it is authenticated by `PoolPeerGuard`, and it accepts no API key — a lookup there is a SELECT per hop for nothing. |
| `inference` is standalone, like `qa:read` | This key gets pasted into an editor's settings file. One row also carrying `mcp` would put install and uninstall behind a string handed to a third-party tool. |
| Capability is inert on an `inference` key, and its picker is hidden | Capability grades the MCP tool surface; this key reaches no tool, so every level would mean the same thing. A control that changes nothing is worse than none. |
| The owner/admin `full` gate is written as `scope !== 'inference'` | Fails closed: a body constructed without the DTO (a test, a future scope) lands on the gate rather than skipping it by omitting a value. |
| Listing merge reads `last_capabilities`, not a fresh probe | It is the same snapshot the ranker reads, so a listing and the next completion cannot disagree, and it costs no network I/O. |
| Peer-only listing rows carry empty metadata, not invented values | A peer publishes model names only. A fabricated `size` would be read as fact by anything doing disk arithmetic. |
| `llamacpp` is opt-in; `lmstudio` is not | `llama-server` and mlx-dspark both default to port 8080. Probing it unasked would find dspark on an Apple Silicon host, get a good OpenAI-compatible answer, and report one engine as two — double-counting that machine in pool ranking. LM Studio's 1234 collides with nothing. |
| `SPEC_DECODE` grew an `'unmeasured'` state rather than new measured-looking rows | That table's own docblock says vendor documentation got two rows wrong. Neither engine has been driven on this fleet, and saying so is the only honest row. |
| The llama.cpp thinking-suppression row cites the lemonade measurement | Lemonade *is* llama-server behind a wrapper, and those three nodes ran `llama-server b10707`. The row says the claim is as strong as that indirection and no stronger. |
| `OPERATOR_MINTABLE_SCOPES` moved to `@ci-hub/common` | Both ends of one contract need it: the DTO validates against it, the picker renders it. A screen offering a scope the route refuses is the failure this prevents. |

---

## Files touched

Backend — `api-keys/` (scopes, DTO, admin service/controller), `auth/` (middleware, new
`inference-api-routes.ts`, `internal-network.guard.ts`), `hub-pool/` (`pool-model-listing.ts` new,
proxy service, `pool-app.guard.ts`), `inference/` (two new backends, registry, module, controller,
env resolver, supervision resolver, catalog, `eval/`).

Frontend — `api-keys.tsx`, `scope-badge.tsx`, `backend-selection-card.tsx`,
`inference-backend-availability.ts`, `hub-status-tooltips.ts`.

Common — `types/inference.ts`, new `types/api-key-scopes.ts`, `i18n/translations/en{,-US}.json`.

Scripts — `lib/cli-api-key.ts`, `pool-diagnostics-cli.ts`. Compose — three files.

Docs — new `connect-developer-tools.md`; `README.md`, `docs/README.md`, `CLI.md`, `hub-pool.md`,
`ARCHITECTURE.md`, `system/backend.md`.

---

## Tests run

- [x] `pnpm run tsc` — 3 packages clean
- [x] `pnpm test` — backend 6007, frontend 1878, common 256, openclaw-plugin 44, CLI 1910
- [ ] App run (`pnpm run local`) — **not run: no Docker daemon on this host.** See handoff.
- [ ] `bin/agent-validate-shift`

New coverage: `pool-model-listing.test.ts`, `llamacpp.backend.test.ts`, `lmstudio.backend.test.ts`,
`inference-module-wiring.test.ts`, plus blocks in the auth middleware, both origin guards, the
api-key admin controller, the api-keys screen, and the CLI.

`inference-module-wiring.test.ts` was mutation-checked: removing `LlamacppBackend` from the module's
providers fails it with the right message, so it catches the boot-time DI error it exists for.

---

## Open items / handoff

- **The app was not run.** Docker is not running on this host, so `pnpm run local` cannot bring up
  Postgres/RabbitMQ, and starting Docker Desktop was out of scope for the task. The boot-time risk
  this leaves is Nest DI, which `inference-module-wiring.test.ts` and the real-injector test in
  `backend-registry.test.ts` now cover. Somebody should still run it before merge.
- **Neither new engine has been driven.** `SPEC_DECODE`, `THINKING_SUPPRESSION` and the conformance
  skips say so explicitly. A run against a real `llama-server` and a real LM Studio should replace
  those rows and move both engines out of `chatOnly()` if they prove `/v1/completions` and
  `/v1/embeddings`.
- **No Settings field for `LLAMACPP_URL` / `LMSTUDIO_URL`.** Environment-only, like Lucebox, because
  `ConfigurationService.setInferencePreferences` already takes eight positional parameters. Rework
  that signature before adding a ninth.
- **Not attempted, and deliberately:** training (LoRA/GRPO rollouts across the pool) and routing
  ComfyUI image/video through the pool. Both are real gaps against AI Grid; neither is a small one.
  The second has a documented consequence today — a peer whose GPU is busy with ComfyUI still
  reports an empty queue (`hub-pool.md`, Known limitations).

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| — | — | — | None; single-session implementation against an explicit user request. `bin/agent-review --phase wrap` still owed. |
