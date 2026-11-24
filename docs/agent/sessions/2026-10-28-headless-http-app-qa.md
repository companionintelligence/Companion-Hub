# Headless HTTP App QA and Release Contract Sync

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `headless-http-app-qa` |
| **Date** | 2026-10-28 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | Test headless Marketplace services and close Hub release validation drift |

## Goal

Run the normal HTTP/TCP readiness lane for no-GUI apps that declare a supported main-service port, keep MCP apps on their stdio protocol lane, and align Hub API artifacts and identity tests with current source.

## Steps taken

1. Added an inline QA route policy in `scripts/qa-stream.ts` so fleet nodes that copy only this file receive the complete implementation.
2. Kept no-GUI screenshots suppressed, skipped portless and UDP-only services explicitly, and made a healthy headless service eligible for `pass` while retaining backend-degraded warnings.
3. Added regression checks covering route selection, main-service port handling, UDP/TCP cases, unsupported silent protocols, scoring, and runner wiring.
4. Updated forward-auth resolver expectations to verify the current user and Hub KERI AIDs.
5. Regenerated the Hub OpenAPI schema and frontend API client from current source.
6. Reviewed the live Marketplace promotion policy and active full-fleet QA run; did not change catalog manifests or production state.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Keep the route helper inline in `qa-stream.ts` | The fleet dispatcher transfers this file and `qa-mcp.ts`; a new sibling module would be absent on remote nodes. |
| Require a numeric main `internalPort` and reject UDP-only mappings | The runner's readiness path publishes and probes a numeric TCP container port. |
| Preserve explicit skips where no supported network probe exists | A blind pass or timeout would misstate what the harness established. |
| Regenerate API artifacts and update identity expectations | `check:openapi` reported source/spec/client drift, and the resolver now returns both KERI AIDs. |

## Files touched

- `scripts/qa-stream.ts`
- `scripts/__tests__/qa-route-policy.test.ts`
- `docs/E2E_TESTING_STRATEGY.md`
- `docs/MCP_TESTING_STRATEGY.md`
- `docs/system/agent-qa.md`
- `packages/backend/src/modules/auth/__tests__/forward-auth-identity.resolver.test.ts`
- `packages/backend/src/swagger.json`
- `packages/frontend/src/api-client/`
- This session worksheet and feedback.

## Tests run

- [x] Route policy tests: 16 passed.
- [x] Backend suite: 442 test files passed, 1 skipped; 10,431 tests passed, 7 skipped.
- [x] Workspace `pnpm run test`, including CLI and entrypoint checks: passed.
- [x] `pnpm run tsc`: passed; Vite/React Router emitted Node-version/configuration warnings on the laptop's Node 22.15.1.
- [x] `pnpm run check:openapi`: passed after regenerating the spec and client.
- [x] Changed-file Biome check and `git diff --check`.
- [ ] `pnpm run lint:ci`: blocked by 17 existing warnings in unrelated KERI files; changed files pass Biome.
- [ ] `bin/agent-validate-shift`: not green because its lint gate fails on those same warnings.
- [ ] Local app run: unavailable because the local Docker/Colima socket is missing. The active full-fleet run copied the prior `qa-stream.ts`, so it does not verify this change.

## Open items / handoff

- Wait for `fleet-apps-1793218733730` to finish on the unchanged Marketplace `dev` catalog, then run `ci-ha-voice` with the new harness if its private images are available to the QA node.
- Regenerate a final full-catalog runtime report with the updated runner before evaluating verified promotion.
- The full production Marketplace gate currently has 582 candidates, 13 static passes, and 569 blocked findings (568 privacy declarations, 43 gallery images; 42 overlap). Do not treat the in-progress fleet report as verified promotion evidence.
- The full gate remains advisory in the production deploy workflow during legacy metadata backfill.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Wrap | Code quality | GPT-6 Astra | Reviews found false-ready handling and procfs uncertainty edge cases, including an unreadable IPv4/IPv6 table. Each was corrected with regression coverage; final follow-up returned no findings. |
