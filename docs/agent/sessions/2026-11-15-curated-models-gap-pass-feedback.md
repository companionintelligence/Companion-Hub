# Session Feedback: curated-models-gap-pass

> Worksheet: [2026-11-15-curated-models-gap-pass.md](2026-11-15-curated-models-gap-pass.md)

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-11-15-curated-models-gap-pass.md` |
| **Date** | 2026-11-15 |

---

## What worked

- Running the K2 Horizon template claim on a live Ollama before listing the model. The task said to test it, and the run turned a claim into an exact statement: only bartowski's GGUF templates raise on an assistant turn with no thinking field, and IFM's builds do not. It also found what the task did not mention: the `hf.co/` route of the same model blob reports no thinking capability on Ollama 0.40.16 (`think: true` answers HTTP 400), while the vendor's own namespace declares it. That decided which route to list.
- Reading Ollama's capability rules in its source (config `capabilities` and `parser`, then the Go template, then the GGUF's chat template) instead of copying the library page's badges. Three of the 21 rows differ from their pages (`olmo-3.1:32b` has no tools, Hy3 has no thinking, MiniCPM5 has both), and the same read showed that two older rows, `olmo-3-7b` and `olmo-3-32b`, have the opposite error.
- Replaying every `repo:QUANT` checkpoint of Lemonade's registry (19 of 41) through the old and the new file selection before replacing the old one. It turned "no existing entry changes" from a hope into a measurement.
- Pinning each new field in a test and then planting defects one at a time (79). The first suite let a changed tier, purpose, and `gb` through, and those fields are now pinned. The one survivor is equivalent, and the note says why.
- Reviews by a model other than the implementer, given the code and the task and not the author's conclusions, four times as the work changed. They found errors my own checks had passed (flags taken from badges, an IFM repo count, a rule in the docs that Ollama's source contradicts, twice, and a shard collector that summed a sibling set) and statements in the notes that said more than had been checked. The last round, on only the fixes the previous one prompted, still found three overstatements in the text I had just rewritten from Ollama's source, so a rewritten rule is worth a review of its own.
- Fixing the generator's two bugs where they were found, with tests built from the real file trees of the repos that exposed them (Hy3's `-mtp` sibling, Qwen3-Next's missing `full_attention_interval`).

---

## Friction / blockers

- #2475, #2476, and #2477 merged while this ran. #2477 had rewritten, in `gen-kv-geometry.ts`, the lines my guard replaced, so the rebase had one conflict. Stacking on open branches was allowed and worked, but the last stretch of a session that stacks on open PRs is a rebase.
- The backend's vitest setup mocks `fs`, so a test that reads the catalog's source text needs `vi.importActual('node:fs')`. It failed in a confusing way (an empty read) before I knew.
- `origin/dev` fails `lint:ci` on `packages/backend/build.ts`, so the gate cannot be read as pass or fail and has to be compared with the base by hand.
- Git refuses to move a scratch worktree to another commit while it holds copies of files, so the planted-defect worktree was synced by copying.
- `check-rows.ts` did not exist when the task was written, and landed in the middle of the session. It would have caught the sharded and over-pin rows of the first refresh; for this pass it confirmed 16 of 21 rows and the five known K2 warnings, and it cannot see a wrong flag.

---

## Workflow improvements

- When a task says "test X on Ollama first", the dated note should carry the Ollama version, the tag, and the requests that were run, and say which sibling builds were not run. The K2 note does; it would help to make it the habit.
- `docs/agent/TESTING.md` could say that the backend's vitest setup mocks `fs`, and how to read a source file in a test.
- A count in a commit message or a note ("the 19 checkpoints") should come from the script that produced it, with its denominator. Mine was the subset behind the catalog's own rows, and a reviewer found that the registry holds 98.
- `docs/MODEL_REGISTRY.md` now says where `reason`, `vision`, and `tools` come from (this PR). The first refresh's rows still follow the library badges, which the dated note says.

---

## Tooling gaps

- `check-rows.ts` does not compare a row's `reason`, `vision`, and `tools` with the config blob's `capabilities` and `parser`. Five rows (the three new ones and two older OLMo 3 rows) differ from their pages, so the check would have found them. The row-checker session lists it as not built.
- `recommendation-sweep.ts` shows text picks only; a reviewer suggested adding the vision picks.
- Nothing checks the dated notes' own claims (versions, digests, byte counts). Three review rounds did it by hand.

---

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-11-15 — curated-models-gap-pass: Take `reason`/`vision`/`tools` from what the build offers through Ollama and not from library badges, test a chat-template claim on a running Ollama before listing the model, pick a GGUF by its exact quant name and compare its size with the registry's model layer, and replay the old and new selection over every registry entry before replacing it.
