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

Pressing Save from there unpins every pinned model, via the deselection loop.

**Correction — the issue's second claim does not hold, and neither did my first trace of it.** #1106
says such a save also clears the stored chat/embedding/vision defaults, and I confirmed that by
reading `setInferencePreferences` ("Pass `null` to clear it") down to `mergeSettingsToDisk`. That
trace started one layer too low. `saveInferencePreferences` maps every `null` to `undefined`
(`inference-api.ts:102`), `jsonBodySerializer` is `JSON.stringify`, which drops undefined keys, and
the controller only writes a field it actually received — the backend's own test asserts exactly
that shape. Verified by serializing the real body: `{"backend":"ollama"}`. So preferences survive.

The consequence is that the documented `null`-clear channel is dead for every frontend caller —
including `vllmApiKey: null`, which is meant to drop a stored key when the operator leaves vLLM.
That is a real defect, filed separately; it is not something to fix under cover of this one.

---

## Steps taken

1. Traced the seed to `applyTrackedModels`, and its data to `ModelRegistryService.trackedModels` —
   `trackModel()` is only ever called from `ModelPullerService`, and `onModuleInit` only logs the
   catalog size, so nothing reconciles the map against reality.
2. Traced the save path to disk and got it wrong the first time — see the correction above. The
   trace skipped `saveInferencePreferences`, the one layer that decides whether a `null` survives.
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
| Warn on an emptying Save instead of blocking it | After the seeding fix, an empty selection is a deliberate act — it is how you unpin everything. Blocking would remove a real capability. The generic "this will restart your apps" copy was the actual problem: it gave no hint that the pins go with it. |
| Warn about unpinning only | Two rewrites got here. It was first keyed to `installedCatalogIds` being non-empty, as the issue suggests, then to "a stored preference or a pin exists". Both rested on the belief that an emptying save clears preferences, which the Goal section above records as false. Unpinning is the only destruction such a save performs, so that is all the copy claims. Warning about a clear the wire cannot carry would teach the operator to click through the one dialog that means something. |
| Count only `unpinnablePins`, not every tracked pin | I had asserted in a code comment that `pinnedModelIds` "is the same set the unpin loop walks". It is not: the loop walks pins that are Ollama-backed *and* still in the tier's model list. A vLLM pin, or one dropped by a re-tier, would have made the dialog promise a release that never happens. Both the save and the copy now call one helper. |
| Seed with the same compatibility predicate the save uses | The seed originally mirrored onboarding's rule, which admits Ollama embeddings only when chat is on vLLM, while the save admits them on any backend. On Lemonade that gap left an installed Ollama embedding model permanently unselected but still save-compatible — so its stored preference would be cleared on every save. Exactly the bug this fix exists to close, surviving on a different backend. |
| Share one compatibility predicate between the save and the dialog | The confirmation must describe the outcome that will actually happen. Two independent filters would be free to drift. |
| Replace the backend-switch effect with an explicit handler | The effect depended on `profile` while its own body called `setProfile`, so every refresh re-armed it — an unbounded refetch loop of the most expensive endpoint on the page (measured 143 requests in 400 ms; 165 on unmodified `dev`). It also never re-seeded, so switching backend reproduced this very bug one click after load. A handler mirroring onboarding's `handleSelectBackend` fixes both and drops `suppressBackendEffectRef`. Closes #1109. |

---

## Files touched

- `packages/frontend/src/modules/settings/containers/ai-settings.tsx` — preferences-first fetch,
  `seedSelectionFromInstalled`, `applyTrackedModels` no longer writes the selection,
  `compatibleSelection`/`isCompatibleWithBackend`/`unpinnablePins` shared with the save, explicit
  `handleSelectBackend`, conditional confirm copy
- `packages/frontend/src/modules/settings/containers/__tests__/ai-settings.test.tsx` — nine regression tests
- `packages/common/i18n/translations/en.json`, `en-US.json` — `AI_SETTINGS_CONFIRM_UNPIN_{TITLE,DESCRIPTION}`
  (parity is enforced between exactly these two files)

---

## Tests run

| Check | Result |
|-------|--------|
| `ai-settings.test.tsx` | 18 passed |
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
| `warns that an emptying save unpins every pinned model` | the unconditional confirm copy |
| `keeps the ordinary confirmation copy when the selection is not being emptied` | a warning that fires on every save |
| `warns when the save would unpin models the panel is not even showing` | the unconditional confirm copy (vLLM panel, Ollama pins) |
| `does not promise to release a pin the save would leave alone` | gating on `pinnedModelIds` instead of `unpinnablePins` |
| `does not warn when an empty selection has no pins to release` | a warning that fires with nothing to lose |

The confirmation tests were re-verified *with the seeding fix in place and only the dialog reverted*,
so they pin the confirmation logic rather than passing on the back of the seeding change.

---

## Open items / handoff

- **The dead `null`-clear channel.** `saveInferencePreferences` maps `null` to `undefined`, so no
  frontend caller can clear a stored model preference — or the stored `vllmApiKey`, which the save
  explicitly nulls when the operator leaves vLLM, meaning a credential they believe revoked stays
  on disk. Fixing it means deciding whether "no compatible selection" should really mean "clear",
  which is a contract decision beyond this issue. Filed separately.
- **Settings → AI "Re-check" still has the #1105 defect.** `onRecheck={checkVllmStatus}` /
  `onRecheck={checkOllamaStatus}` is the pre-fix wiring; PR #1107 fixed only the onboarding copy.
- **The tracked registry still empties on restart.** This change stops the UI depending on it, but
  the underlying registry is still unreconciled — persisting it, or rebuilding it from backend
  health at startup, would remove this whole class of bug.
- **The tracked registry still drives `pinnedModelIds` and the per-model badge.** Both go empty
  after a restart, so a pinned model shows no pin badge and deselecting it unpins nothing — the
  same self-contradiction this change removed from the checkboxes, one row over. Rehydrating the
  registry from backend health at boot is the durable fix (see above).

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
| review | multi-angle (`/code-review max --fix`) | Opus | Caught that the whole destructive-save premise was false one layer below where I stopped tracing — `saveInferencePreferences` maps `null` to `undefined`, so no frontend caller can clear a preference. Copy rewritten to claim only the unpinning that happens; dead `null` channel filed separately. Also replaced the looping backend-switch effect with an explicit `handleSelectBackend` that re-seeds (closing #1109 and the one-click reproduction of #1106), corrected the `pinnedModelIds` claim, added the missing `unpinInferenceModel` test mock, and de-flaked an exact poll-count assertion |
| wrap | self-review (dry run) | Opus | Three findings, all fixed: the warning was gated on `installedCatalogIds` so it went silent when the backend was down (the case it most needs to cover); the seed used a narrower compatibility rule than the save, leaving Lemonade's Ollama embeddings permanently unselected but still save-compatible; and two render-time predicates duplicated the new shared helper. Verified separately that unpin leaves `state: 'loaded'`, so post-save re-selection is unchanged from before this PR |
