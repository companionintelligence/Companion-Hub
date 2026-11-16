# Session Feedback: omlx-model-id-matching

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-11-15-omlx-model-id-matching.md` |
| **Date** | 2026-11-15 |

## What worked

- The installed oMLX app ships its Python source. Reading `model_discovery.py`, `engine_pool.py` and `server.py` of the version that was running gave the naming rules in minutes, and a throwaway server then confirmed them.
- A throwaway server with its own `--base-path`, `--api-key` and port, over a copy of one cached model, measured both layouts and an alias without touching the operator's `~/.omlx` or downloading anything. The listing needs no model load, and one 1B request was enough to show that `/v1/models` does not change when a model loads.
- Giving a test the shape the engine really returns found a second problem the comparison fix alone would have created: from the Hugging Face cache, oMLX answers the catalog's `mlx-community/<name>` with a 404.
- Running the changed tests against an untouched checkout of `origin/dev` in a second worktree showed which of them were new evidence (32 failures) and which only guarded against over-matching.
- An independent read-only review by an agent with no shared context found a real bug in my first cut (the match ignored the organization, so a same-named build from another publisher could win, because oMLX lists ids sorted) and three tests that could not tell a fallback from an over-match. It checked every naming claim against the oMLX source on its own. Handing it the diff, the paths of the oMLX source and a list of what to look for, but not my conclusions, worked.
- A small script that breaks one behavior at a time, runs the tests that should notice and writes the original file back in a `finally` found nothing missed after the review's fixes, and took minutes. 16 mutations, all caught.

## Friction / blockers

- `pnpm run lint:ci` fails on `origin/dev` (a format diff in `packages/backend/build.ts`), so `bin/agent-validate-shift`, which stops at the first failure, cannot pass for any change until that file is fixed.
- `pnpm run tsc` inside `packages/backend` fails with "Cannot find module '@ci-hub/common/types'" until `@ci-hub/common` is built; the root `pnpm run tsc` (turbo) builds it first.
- Four tests had mocked `/v1/models` ids that oMLX never returns, and one test file (`omlx.backend.test.ts`) already used the real shape, so the two did not agree. Nothing in the repo records where the real shapes come from.
- The default shell is zsh: an unquoted `$FILES` does not word-split, and a `${(f)...}` expansion in a command made the sandbox's `rm` check refuse to parse it.

## Workflow improvements

- When a test mocks an engine's reply, put one real captured body next to the mock, with the engine version, so a later change to the mock can be checked against it. `omlx.backend.test.ts` now says which version its ids come from.
- Fix the `build.ts` format error on `dev` so the end-of-shift gate can pass.

## Tooling gaps

- A fixture-capture script for engine replies (start the engine, record `/v1/models`, `/health` and the load state, redact the key) would make "measured on version X" cheap to repeat. The one used here is in the shared notes folder for this session.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-11-15 — omlx-model-id-matching: oMLX lists a model by its directory name or `<org>--<name>` from the Hugging Face cache, not the catalog's `<org>/<name>`; the backend now matches by name and organization and hands out the listed name, found by running a throwaway oMLX over one cached model in each layout, then hardened by an independent review and one-at-a-time mutations.
