# Session Feedback Template

> Copy alongside your worksheet: `docs/agent/sessions/YYYY-MM-DD-<slug>-feedback.md`
> Append a one-line summary to [WORKFLOW_FEEDBACK.md](WORKFLOW_FEEDBACK.md)

---

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-07-25-local-dev-app-dir.md` |
| **Date** | 2026-07-25 |

---

## What worked

- The existing `CI_HUB_DATA_DIR`/`CI_HUB_APP_DATA_DIR` remapping pattern in `ensureLocalDevRuntimeEnv()` made the fix obvious once the root cause was found — same shape, one line.
- `bin/agent-validate-shift` caught the full test suite (2012+722+274 tests) cleanly in one gate, no surprises.

---

## Friction / blockers

- `bin/agent-review` only *prints* a review prompt for pasting into a separate agent session — it doesn't invoke anything itself. No MCP-connected reviewer was available in this environment, so the cross-review step had to be fulfilled by hand via a generic subagent tool instead of the documented flow. This worked, but isn't what the doc describes.
- `CI_HUB_TUNNEL_DIR` exists in `packages/backend/src/common/constants.ts` as a documented override, and is even referenced by comment ("tests can redirect it with CI_HUB_TUNNEL_DIR"), but it's silently dead for the `local`/`dev` turbo tasks because it's not in `turbo.json`'s per-task `env` allowlist. Took real digging (checking `/proc/<pid>/environ` on the running backend) to discover the var never arrived. A comment on `CI_HUB_TUNNEL_DIR` in constants.ts noting the turbo allowlist requirement would have saved this.
- `bin/cihub` (the compiled standalone binary in `bin/`) and `pnpm run local` (tsx-run TS source) are two different code paths that can silently diverge — editing `scripts/cihub-cli.ts` and testing via `./bin/cihub up local` looks like it's exercising the fix but is actually still running the old compiled snapshot. Easy to burn a cycle on this without noticing.

---

## Workflow improvements

- Consider adding a one-line note to `turbo.json` (or `docs/system/`) listing which `CI_HUB_*` env vars are allowlisted per task, since `packages/backend/src/common/constants.ts` defines several more than turbo currently passes through — the mismatch is invisible until you inspect the running process's actual environment.
- Consider a comment on `bin/cihub` explaining it's a built artifact that does NOT reflect uncommitted `scripts/*.ts` changes, and that source-level CLI testing should go through `pnpm run local` / `pnpm exec tsx scripts/start.ts`.

---

## Tooling gaps

- No local reviewer agent/model distinct from the implementer was configured in this environment; `bin/agent-review`'s "paste into a different agent session" step had no target to paste into. A lightweight local review script (even a canned checklist runner) would make the documented flow actually executable end-to-end without a human relay.

---

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-07-25 — local-dev-app-dir: Fixed `ensureLocalDevRuntimeEnv` to remap `CI_HUB_APP_DIR` for source-based local dev (was breaking Cloudflare Tunnel with EACCES + wrong compose-file path); surfaced that `CI_HUB_TUNNEL_DIR` is dead-on-arrival due to a turbo.json env allowlist gap.
