# Session Worksheet — Re-check refetches the model list

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `recheck-refetches-model-list` |
| **Date** | 2026-08-11 |
| **Agent** | Claude Code |
| **Model** | Opus |
| **Task** | CI-Hub#1105 — "Re-check" doesn't refetch the model list, so an externally-loaded vLLM model never shows as Installed |

---

## Goal

Make the **Re-check** button complete the flow the product documents. `ONBOARDING_VLLM_NOT_DETECTED_DESC` tells the operator to "load a model, then re-check", but the button only re-probed `/api/inference/vllm/status`. It never refetched the onboarding profile, so `installedCatalogIds` kept whatever value it held at mount and the model card stayed unselectable — clicking it kept opening Hugging Face. Reproduced live on a Hub whose host vLLM was serving `Qwen/Qwen3-4B-Instruct-2507`: the banner went green, the card did not change, and only **Rescan** (which does call `fetchProfile`) fixed it.

---

## Steps taken

1. Traced the click path: `onRecheck={checkVllmStatus}` → `fetchVllmInstallStatus()` → `setVllmStatus()`, with no profile refresh.
2. Established that `fetchProfile` had exactly three call sites — mount, `handleRescan`, and the Ollama `Retry` button — none of them Re-check.
3. Confirmed the gate is `handleToggleModel`'s early return: while `installedCatalogIds` is stale, a vLLM card is permanently in the "open Hugging Face" branch.
4. First attempt reused `fetchProfile(true, selectedBackend)`. Self-review found it altered two unrelated behaviours, both proven with tests before changing course:
   - `fetchProfile` unconditionally calls `setSelectedModelIds(getDefaultSelectedModelIds(...))`, so re-checking discarded model choices the operator had already made.
   - Its `catch` calls `setError`, and the component renders `ai-setup-error` for `if (error || !profile)` — so a transient failure on a secondary, user-initiated refresh replaced the entire step with the error screen.
5. Replaced it with `refreshInstalledModels()`: fetches the profile for the current backend, updates `profile`, and reconciles the selection against what the backend now reports.
6. Added `data-testid` to both branches of each setup card (only one renders at a time) — the two cards share the "Re-check" aria-label, so the label alone is ambiguous in tests.
7. Ran the app: frontend dev server on `:5011` with `API_PORT=5002` proxying to the live Hub backend; `/onboarding` and `/settings/ai` both compile and serve 200 with no SSR errors.
8. Multi-angle review round found eight further defects in the new function, all fixed and pinned by tests: refreshing against a *down* backend wiped the installed list (the profile endpoint answers 200 with nothing served); no request-generation guard, so a superseded answer could clobber a rescan or a backend switch; the selection merge read a render closure, so a tick made mid-flight was reverted; the `!preferredModelId` guard was dead because `fetchProfile` always seeds a placeholder; no prune for models the host stopped serving; `checking` cleared before the slow half, leaving the button live; a silent `catch`; and the Ollama path had no testid or coverage.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| A dedicated `refreshInstalledModels` rather than reusing `fetchProfile` | `fetchProfile` exists to (re)establish defaults: it resets the selection, the preferred model, the backend, and raises the error screen on failure. Re-check needs one of those effects and none of the others. Reusing it traded the reported bug for two new ones. |
| Separate `handleRecheck` wrapper instead of refreshing inside `checkVllmStatus` | The probe helpers also run on mount, where `selectedBackend` is still the initial `'ollama'`, so a refresh there would read the wrong backend. |
| Adopt only models installed *since the last look* | A plain union would re-tick a model the operator had deliberately unticked. Diffing against the previous `installedCatalogIds` adopts genuinely new models and leaves every existing choice alone. |
| Gate the refresh on `status.ready` | The profile endpoint catches its own backend health failure and answers 200 with `modelsLoaded: []`. Refreshing against a down backend therefore *erases* installed models rather than revealing new ones — recreating the reported bug through the button that fixes it. This also keeps the Tauri auto-install poll (10 × 2s) on the cheap probe until Ollama is actually up. |
| Re-point `preferredModelId` when it is neither installed nor selected | `fetchProfile` seeds a placeholder from the catalog before anything is installed, so "only fill when unset" never fired and the agent-default badge stayed on a model the host does not serve. A model the operator picked is still never overridden. |
| Read selection state through refs, guard writes with a request id | Both the selection merge and the profile write happen after an await. The closure values are stale by then, and a superseded response could reinstate pre-rescan hardware or a backend the operator has already switched away from. |
| Prune vLLM models the host stopped serving | `handleToggleModel` only lets a vLLM model be ticked while it is served, so leaving a stale one selected breaks that invariant and bills it to `computeSelectionBudget` as a pending download, which can block Continue on disk. Scoped to vLLM so the Ollama pull-before-install flow is untouched. |
| `console.warn` on refresh failure | Still no error screen — but a silent no-op is indistinguishable from the bug this function exists to fix, and unfalsifiable in support triage. |
| Applied to the Ollama cards too | `checkOllamaStatus` has the identical shape and the same defect; a model pulled outside the Hub hits the same stale list. |

---

## Files touched

- `packages/frontend/src/modules/onboarding/components/ai-setup-step.tsx` — `refreshInstalledModels` + `handleRecheck`; rewired vLLM + both Ollama `onRecheck` props
- `packages/frontend/src/modules/onboarding/components/ai-setup/vllm-setup-card.tsx` — `data-testid="vllm-recheck-btn"` on both branches
- `packages/frontend/src/modules/onboarding/components/ai-setup/ollama-setup-card.tsx` — `data-testid="ollama-recheck-btn"` on both branches
- `packages/frontend/src/modules/onboarding/components/__tests__/ai-setup-step.test.tsx` — six regression tests, module-level vLLM fixtures

---

## Tests run

| Check | Result |
|-------|--------|
| `ai-setup-step.test.tsx` | 58 passed |
| `src/modules/onboarding` + `src/modules/settings` | 32 files, 243 passed |
| `bin/agent-validate-shift` | `lint:ci` ✓ `tsc` ✓ `test` ✓ |
| App run | dev server + live backend; `/onboarding`, `/settings/ai` → 200, no SSR errors |

Every test was verified against the specific implementation it guards, by reverting to that
implementation and confirming the expected failure:

| Test | Fails against |
|------|---------------|
| `refreshes the model list on vLLM re-check…` | probe only, no refresh (the original bug) |
| `keeps the selected backend when re-checking…` | a refresh that does not pass the current backend |
| `does not discard model choices…` | the blunt `fetchProfile(true, selectedBackend)` first attempt |
| `keeps the step usable when the profile refresh fails…` | the same first attempt (error screen on failure) |
| `keeps a model ticked while the re-check refresh is still in flight` | merging onto the render closure instead of a ref |
| `does not wipe the installed model list when re-checking a backend that is down` | dropping the `status.ready` gate |
| `does not let a slow rescan snap the backend away from the one just picked` | the unguarded `fetchProfile` write |
| `does not let a superseded backend switch overwrite the profile with the abandoned backend` | the unguarded `handleSelectBackend` write |
| `does not raise the error screen for a superseded profile request that failed` | the unguarded `catch` |

Reverting the refresh entirely — the original bug — fails four of the first six.

Two validation failures were investigated and traced to the environment, not the change:

- `scripts/__tests__/cihub-cli.test.ts` fails whenever `.env.local` is sourced into the test
  process — it exports `ROOT_FOLDER_HOST`, which sends `ensureLocalDevRuntimeEnv` to a
  `.internal/` directory that does not exist in this checkout. Reproduced deterministically both
  ways on the same commit; exporting only `NODE_AUTH_TOKEN` avoids it.
- `settings/containers/general-actions.test.tsx` failed one loaded run (`getBy` on
  `hub-shell-update-btn` with no `waitFor`) and passed on a re-run of the same tree; the clean
  tree passed the same loaded run. Load-dependent flake in a module with no import path from
  onboarding.

---

## Open items / handoff

- **Settings → AI has the same defect, unfixed.** `ai-settings.tsx:517,524` still wires `onRecheck={checkVllmStatus}` / `onRecheck={checkOllamaStatus}` — the pre-fix wiring — and drives its model grid from `profile.installedCatalogIds`. The two screens now behave differently for the same button. Left out of this PR as a separate ~700-line container with its own state model; tracked alongside CI-Hub#1106, which touches the same file.
- **The mechanism is worth fixing one level down.** `getVllmStatus` already calls `vllmBackend.healthCheck()`, which returns `modelsLoaded` — the served-model list — and discards it (`inference.controller.ts:410-428`). `getOnboardingProfile` then calls the same `healthCheck()` again to derive `installedCatalogIds`. Returning the installed ids from the status endpoint would make one probe answer both questions, delete `refreshInstalledModels` entirely, and heal Settings → AI for free.
- **`handleSelectBackend` still has the error-screen hazard** this session diagnosed. Its catch calls `setError` with `profile` non-null, so a transient failure while switching backends replaces the step and discards the in-progress setup. Pre-existing and untouched here; fixing it means deciding an error policy for that path.
- **`login-journey.test.tsx` runs on a thin margin.** The `email → Portal → pick Hub` case takes 3.1–4.3s against vitest's 5s default and times out under suite load. Pre-existing fragility, not caused by this change, but worth a longer timeout or a trim.

---

## Notes

- The environment initially could not install dependencies: `.npmrc` resolves `${NODE_AUTH_TOKEN}`, which was unset, so `@companionintelligence/tokens` 401'd and left real deps missing (`ansi-to-html`). That surfaced as 24 phantom `tsc` errors and an SSR failure. With the token exported and `@ci-hub/common` rebuilt, the frontend typechecks at 0 errors.
- Screenshots for the acceptance criteria are attached to the issue/PR by the operator — the before state is captured in #1105.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| impl | self-review (dry run) | Opus | Caught the first attempt's two regressions — selection reset and error-screen takeover — before review; both pinned by tests |
| wrap | multi-angle (correctness, React pitfalls, cross-file, reuse, simplification, efficiency, altitude, conventions) | Opus | 15 findings; fixed the down-backend wipe, stale-response clobber, lost update, dead preferred-model guard, missing prune, spinner gap, silent catch, Ollama testid, and four test-quality issues. Settings → AI and `handleSelectBackend` deferred — see Open items |
| PR | Copilot | — | One finding, valid: `profileRequestId` was a write barrier only `refreshInstalledModels` honoured — `fetchProfile` and `handleSelectBackend` bumped it and applied their response unconditionally. Both guarded, failure paths included, three tests added |
