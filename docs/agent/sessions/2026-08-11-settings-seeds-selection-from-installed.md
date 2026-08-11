# Session Worksheet — Settings seeds its model selection from the tracked registry

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `settings-seeds-selection-from-installed` |
| **Date** | 2026-08-11 |
| **Agent** | Claude Code |
| **Model** | Opus |
| **Task** | CI-Hub#1106 — Settings → AI seeds model selection from the in-memory tracked registry, so installed models show unselected and Saving clears preferences |

---

## Goal

Make Settings → AI agree with the backend about what is installed, and stop a Save made from that
disagreement being silently destructive.

`applyTrackedModels` was the only thing that seeded `selectedModelIds`, and its source is a
`Map` held in the Hub process that nothing rebuilds at startup. So every installed model read as
unselected after a restart, and always for vLLM models (the Hub never pulls those — the operator
loads them on the host). The panel's own copy says the best fit is "pre-selected", and the
**Downloaded Models** section on the same page correctly showed the model as present, so the
checkboxes were visibly contradicting their own screen.

Pressing Save from there does two destructive things, both verified end-to-end rather than assumed:
`resolvePreferredModelId` returns `null` for every role, and `setInferencePreferences` is documented
`Pass null to clear it` — `JSON.stringify` then drops the key from `settings.json`, so the stored
chat/embedding/vision defaults are gone. Every pinned model is then unpinned by the deselection loop.

---

## Steps taken

1. Traced the seed to `applyTrackedModels`, and its data to `ModelRegistryService.trackedModels` —
   `trackModel()` is only ever called from `ModelPullerService`, and `onModuleInit` only logs the
   catalog size, so nothing reconciles the map against reality.
2. Followed the destructive path all the way to disk (`resolvePreferredModelId` → `saveInferencePreferences`
   → `configuration.service.setInferencePreferences` → `mergeSettingsToDisk`) to confirm `null` really
   does clear a stored preference rather than leave it untouched.
3. Seeded the selection from `installedCatalogIds` — the same source onboarding uses — with the
   tracked registry allowed only to *add*, never to define the set.
4. Found that seeding alone would not have fixed the reported bug: `fetchProfile` asked the profile
   endpoint for no backend, and `installBackend = query?.backend ?? recommendedBackend` means it
   answers for the *hardware recommendation*. With a stored preference that differs (exactly the
   vLLM case — see #1103, where the recommender can pick Ollama for a machine running vLLM), the
   installed set described a backend the panel was not showing and the union matched nothing.
   Preferences are now read first and the profile is fetched for that backend.
5. Separated selection seeding from `applyTrackedModels`, because the pull poller also lands there
   every few seconds and would otherwise rewrite the checkboxes from under the operator.
6. Made the existing Save confirmation say what an empty selection will actually do, rather than
   blocking it — deselecting everything is a legitimate way to unpin.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Union `installedCatalogIds` with tracked states, rather than replacing one with the other | Tracked state carries in-flight transfers (`pulling`, `loading`) that the installed set does not know about yet. Installed state survives restarts, which tracked does not. Each covers the other's gap; neither alone is correct. |
| Fetch preferences *before* the profile | The profile endpoint scopes `installedCatalogIds` to the backend it is asked about and defaults to the hardware recommendation. Asking before the stored backend is known returns the installed set for a backend this panel may not be showing — which would have left the fix silently doing nothing for the exact users who reported it. `fetchInferencePreferences` catches its own errors and returns null, so moving it earlier adds no failure mode. |
| `applyTrackedModels` no longer writes the selection | It is called by the pull poller every few seconds while a transfer runs. Writing the selection there reverts anything the operator ticks mid-pull, and drops any model the Hub did not pull itself (every vLLM model) out of the selection. Seeding is now an explicit, separate step. |
| Warn on an emptying Save instead of blocking it | After the seeding fix, an empty selection is a deliberate act — it is how you unpin everything. Blocking would remove a real capability. The generic "this will restart your apps" copy was the actual problem: it gave no hint that the save also wipes the agent defaults. |
| Gate the warning on *something to lose*, not on models being installed | The first version keyed it to `installedCatalogIds` being non-empty, as the issue suggests. That goes quiet in precisely the case that needs it most: a backend that is down answers the profile endpoint with nothing served, so the selection empties for a reason unrelated to intent, and the save then clears preferences with no warning at all. Keying it to a stored preference or an existing pin — the things a save actually destroys — fires exactly when there is loss, and stays silent on a fresh Hub where there is none. |
| Seed with the same compatibility predicate the save uses | The seed originally mirrored onboarding's rule, which admits Ollama embeddings only when chat is on vLLM, while the save admits them on any backend. On Lemonade that gap left an installed Ollama embedding model permanently unselected but still save-compatible — so its stored preference would be cleared on every save. Exactly the bug this fix exists to close, surviving on a different backend. |
| Share one compatibility predicate between the save and the dialog | The confirmation must describe the outcome that will actually happen. Two independent filters would be free to drift. |
| Left the backend-switch path re-seeding untouched | See Open items — that effect has a pre-existing refetch loop, and adding to it before that is fixed would compound the problem. |

---

## Files touched

- `packages/frontend/src/modules/settings/containers/ai-settings.tsx` — preferences-first fetch,
  `seedSelectionFromInstalled`, `applyTrackedModels` no longer writes the selection,
  `compatibleSelection`/`isCompatibleWithBackend` shared with the save, conditional confirm copy
- `packages/frontend/src/modules/settings/containers/__tests__/ai-settings.test.tsx` — six regression tests
- `packages/common/i18n/translations/en.json`, `en-US.json` — `AI_SETTINGS_CONFIRM_CLEAR_{TITLE,DESCRIPTION}`
  (parity is enforced between exactly these two files)

---

## Tests run

| Check | Result |
|-------|--------|
| `ai-settings.test.tsx` | 15 passed |
| `src/modules/settings` + `src/modules/onboarding` | 32 files, 240 passed |
| `bin/agent-validate-shift --skip-openapi --skip-visual --skip-benchmark` | `lint:ci` ✓ `tsc` ✓ `test` ✓ |

Every test was verified against the specific implementation it guards, by reverting to that
implementation and confirming the expected failure:

| Test | Fails against |
|------|---------------|
| `pre-selects models the backend reports installed even when the tracked registry is empty` | tracked-only seeding (the reported bug) |
| `saves an installed model as the agent default instead of clearing the stored preference` | the same — proves the destructive consequence, not just the display |
| `keeps installed models selected while a pull is in progress` | `applyTrackedModels` writing the selection |
| `asks the profile endpoint for the stored backend rather than the hardware recommendation` | the original fetch order |
| `warns that saving an empty selection clears preferences and unpins models` | the unconditional confirm copy |
| `keeps the ordinary confirmation copy when the selection is not being emptied` | a warning that fires on every save |
| `warns about an emptying save even when the backend reports nothing installed` | gating the warning on `installedCatalogIds` |
| `does not warn when an empty selection has no preferences or pins to destroy` | a warning that fires with nothing to lose |

The confirmation tests were re-verified *with the seeding fix in place and only the dialog reverted*,
so they pin the confirmation logic rather than passing on the back of the seeding change.

---

## Open items / handoff

- **`useEffect` on backend switch refetches the profile without bound.** The effect at
  `ai-settings.tsx` lists `profile` in its dependencies and calls `setProfile` with a freshly
  fetched object, so each write retriggers the fetch. Measured **143 profile requests in 400 ms**
  after a single backend switch, and **165 on unmodified `origin/dev`** — pre-existing, not from
  this change. The existing suite never caught it because the fixture returns the *same object
  reference* every call, so React bails out of the state update. Worth its own issue; it also
  blocks re-seeding the selection on backend switch, which is otherwise the obvious follow-up.
- **Settings → AI "Re-check" still has the #1105 defect.** `onRecheck={checkVllmStatus}` /
  `onRecheck={checkOllamaStatus}` is the pre-fix wiring; PR #1107 fixed only the onboarding copy.
- **The tracked registry still empties on restart.** This change stops the UI depending on it, but
  the underlying registry is still unreconciled — persisting it, or rebuilding it from backend
  health at startup, would remove this whole class of bug.
- **Switching backend does not re-seed the selection.** Models installed on the newly selected
  backend read as unselected until reload. The Save warning covers the destructive consequence;
  the display gap needs the refetch loop fixed first.

---

## Notes

- The environment cannot source `.env.local` wholesale before running tests: it exports
  `ROOT_FOLDER_HOST`, which sends `ensureLocalDevRuntimeEnv` to a `.internal/` directory that does
  not exist in this checkout and fails two `scripts/__tests__/cihub-cli.test.ts` cases. Export only
  `NODE_AUTH_TOKEN`.
- `--skip-openapi` because this change is frontend + translations only. Running `check:openapi`
  here regenerates `swagger.json` 98 lines smaller than what is committed, unrelated to this work.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| impl | self-review (dry run) | Opus | Caught that seeding alone would not fix the reported case — the profile was being fetched for the recommended backend, not the stored one — and that the pull poller would overwrite the new seed |
| wrap | self-review (dry run) | Opus | Three findings, all fixed: the warning was gated on `installedCatalogIds` so it went silent when the backend was down (the case it most needs to cover); the seed used a narrower compatibility rule than the save, leaving Lemonade's Ollama embeddings permanently unselected but still save-compatible; and two render-time predicates duplicated the new shared helper. Verified separately that unpin leaves `state: 'loaded'`, so post-save re-selection is unchanged from before this PR |
