# Session Worksheet

> Copy to `docs/agent/sessions/YYYY-MM-DD-<slug>.md` and commit with your work.

---

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `cihub-up-prod-password` |
| **Date** | 2026-08-18 |
| **Agent** | Cursor |
| **Model** | Grok 4.6 |
| **Task** | After a reset, `cihub up prod` should prompt for a password instead of sending the user to the desktop app |

---

## Goal

Appliance-mode `cihub up prod` currently exits when `~/.local/share/companion-hub` has no seeded `.env` + compose. After a full wipe that is the normal state. Seed a fresh install from the bundled compose file and prompt interactively for `POSTGRES_PASSWORD`.

---

## Steps taken

1. Reproduced the current error (`No prod Hub install found` / launch desktop).
2. Added `scripts/lib/seed-appliance.ts` to copy compose, write env files, and resolve a password from TTY or env.
3. Wired `startHub` / `setupHub` in appliance mode through `ensureApplianceInstall()`.
4. Documented the flow in `docs/CLI.md` and `docs/RESET_RUNBOOK.md`.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Prompt only for POSTGRES_PASSWORD | That is the required secret in `.env.example`; JWT and RabbitMQ stay generated |
| Env `POSTGRES_PASSWORD` / `CIHUB_POSTGRES_PASSWORD` skips the prompt | Non-interactive / scripted resets |
| Prefer desktop bundled compose over repo source compose | Appliance must pull `CI_HUB_IMAGE`, not build from source |

---

## Files touched

- `scripts/lib/seed-appliance.ts`
- `scripts/__tests__/seed-appliance.test.ts`
- `scripts/cihub-cli.ts`
- `scripts/lib/cli-ui.ts`
- `scripts/__tests__/cihub-cli.test.ts`
- `docs/CLI.md`
- `docs/RESET_RUNBOOK.md`

---

## Tests run

- [x] `pnpm run test:cli` (seed-appliance + help)
- [ ] `pnpm run lint:ci`
- [ ] `bin/agent-validate-shift`

---

## Open items / handoff

The packaged `cihub` binary on PATH will not pick this up until the next desktop/CLI build. Until then, run the TypeScript CLI from a non-checkout cwd, or rebuild the standalone CLI.
