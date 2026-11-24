# Session Feedback: curated-models-refresh

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-11-15-curated-models-refresh.md` |
| **Date** | 2026-11-15 |

## What worked

- Reading registry manifests, config blobs, and ranged GGUF headers directly, instead of library-page summaries, showed that Mistral Medium 3.5 was wrongly on the fabrication guard and that Qwen 3.8 Flash-Next has a plain GGUF tag.
- Asking Hugging Face's registry endpoint the way Ollama does, before listing an `hf.co/` row, found that sharded GGUFs cannot be pulled, which also exposed two existing rows.
- A before and after sweep of the recommendations caught a default change on 32 GB Macs that no row-level test could see.
- Planting defects in the new tests one at a time found a comment that claimed more than the assertion checked. After the review found the oMLX and vLLM sizes unpinned, a second round of planted size slips showed that the new assertions catch them.
- Running the full gate in a fresh worktree on the latest `origin/dev` found a `knip:ci` failure (an unlisted import in a root script) that a run in the shared checkout had not shown.
- Corrupting the generated file on purpose showed that the first version of the `--only` merge guard did not fire.
- A wrap review by ten reviewers on another model, with three skeptics per serious finding, caught what two verification passes had not: a vision projector missing from one row's size, two wrong vision flags, and two models wrongly called sharded-only. The earlier passes had checked each row against the library page, and the review checked it against everything the pull fetches.

## Friction / blockers

- `pnpm run test` stops at the first failing package, so a frontend failure already on `origin/dev` hid the backend result. The backend lane has to run on its own.
- `origin/dev` was red on `lint:ci` and on one frontend test, so `bin/agent-validate-shift` cannot pass as a whole. Each step had to be run and compared against the base.
- One `scripts` test timed out at 15 seconds while three suites shared the machine, and passed when run alone.
- The decoder throws when a table's header count is too high but silently drops rows when it is too low. The first draft of the procedure text said it throws in both cases.
- A second review round, on the fixes, still found 15 problems: some round-1 fixes were incomplete (a claim corrected in the PR body stayed wrong in a commit message and a test comment) and some new sentences were wrong. When a claim changes, search every file and message for it before the next review.
- Most of the review's findings were claims in comments, docs, and test names that were wrong or overstated (a page count, a bit rate, an error message, a test named for something it did not assert). Checking each claim in a note against raw data before the review would have saved a round.

## Workflow improvements

- Let `bin/agent-validate-shift` keep going after a failing step and print the failures as a set, so a red base is easy to compare against.
- Document the install-and-validate recipe for a temporary worktree, since a fresh worktree needs its own `pnpm install`.

## Tooling gaps

- Nothing checks every catalog row against the registry on a schedule. A nightly pull-path check (manifest status, sharded or not, the Ollama version it requires, the size of every layer) would have flagged `glm-5-2` and `inkling`, the wrongly banned Mistral Medium 3.5, and the missing projector size.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-11-15 — curated-models-refresh: Read registry manifests and GGUF headers instead of page summaries, ask Hugging Face's registry the way Ollama does before listing an `hf.co/` row, sweep recommendations with and without new rows, and plant defects in the new tests one at a time.
