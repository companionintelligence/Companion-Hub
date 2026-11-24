# oMLX model ids: match the names oMLX lists

## Meta

| Field | Value |
| ----- | ----- |
| Slug  | `omlx-model-id-matching` |
| Date  | 2026-11-15 |
| Agent | Claude |
| Model | Sonnet 5.5 |
| Task  | A reviewer of the 2026-11-15 curated-catalog refresh suspected that the Hub's oMLX check never matches the ids oMLX reports. Check it on a real oMLX and fix it if it is real. |

## Goal

Find out whether `OmlxBackend.isModelLoaded` (an exact match of the catalog's `mlx-community/<name>` against the ids in `GET /v1/models`) can ever be true, measure the ids a real oMLX lists, and make every place in the backend that compares or hands out an oMLX model id agree with them.

## Steps taken

1. Read `CONTRIBUTING.md`, `AGENTS.md` and `docs/agent/AGENT_WORKFLOW.md`.
2. Found oMLX 0.7.3.dev1 installed as `/Applications/oMLX.app` on this Mac, with its Python source readable in the bundle (`Contents/Resources/omlx/`). Read `model_discovery.py` (`discover_models`, `_decode_hf_cache_model_id`), `engine_pool.py` (`resolve_model_id`) and `server.py` (`GET /v1/models`, `GET /v1/models/status`, the `model_fallback` branch). Nothing was run against the operator's own oMLX or `~/.omlx`.
3. Ran a throwaway oMLX (`omlx-cli serve` on 127.0.0.1:18765, its own `--base-path`, a random `--api-key`) over `mlx-community/Llama-3.2-1B-Instruct-4bit`, which was already in this Mac's Hugging Face cache (nothing was downloaded): a copy of the files under `<dir>/mlx-community/<name>/` (organized), under `<dir>/<name>/` (flat), as a private copy of the cache entry (`HF_HUB_CACHE`), and organized with a `model_alias`. For each, recorded `/health`, `/v1/models` and `/v1/models/status` before and after the first request, and the status of a chat request under seven spellings of the model's name. Evidence is in the PR description.
4. Traced every place in `packages/backend/src` that compares an engine's listed id with a catalog `backendModelId`, or hands one to an app or an engine (`isModelLoaded`, `servedIdForCatalogModel`, `engineModelKey`, the env and credentials handouts, `auto` resolution, the router's chat path and tracked-model lookup, the pool's inventory de-duplication, the memory manager).
5. Added `common/helpers/omlx-model-id.ts` and routed the shared helpers, the oMLX backend, both handouts and the router through it.
6. Replaced the four mocked `/v1/models` ids that oMLX never produces with the ones it does, added tests for both layouts at each site, and checked that the new tests fail on the unfixed base.
7. **Independent review** by a separate agent that read the diff and the oMLX source cold (see Reviews run). It confirmed the naming rules from the source and found a real bug and several weak tests. Fixed on the same change: the match now compares organizations; `handoutIdForCatalogModel` and `preferredInstalledModel` are scoped to oMLX; `OmlxBackend` keeps the listing of the configured server only; a tracked oMLX row is found by the name an app sends. Then broke each behavior on purpose, one at a time, 16 mutations, and watched a test fail for every one.

## Decisions

| Decision | Rationale |
| -------- | --------- |
| Two ids are one oMLX model when the name matches ignoring case, and the organization matches where both carry one (`omlxModelsMatch`) | The first cut dropped the organization from every id. oMLX lists its ids sorted, so with `lmstudio-community--Qwen3-8B-4bit` and `mlx-community--Qwen3-8B-4bit` both in the cache, the first one was picked, and with only the first one listed the catalog row read as installed. A model directory's own name carries no organization (oMLX drops the folder), so it matches any. Hugging Face bars `--` from repo ids, so the first `--` in a cache id always ends the organization. |
| `servedOmlxId` prefers the catalog spelling, then the bare name, then the cache spelling `<org>--<name>`, each exactly, then any other spelling that matches | A listing can hold one model twice (a directory and a cache entry). Both names serve it, so the order only has to be stable. Exact before case-folded, as oMLX resolves a request. |
| `omlxModelKey` stays organization-less, for `engineModelKey` only | A key that stands for a model in a set or a map cannot compare organizations. `sameEngineModelId` does, for oMLX. The two disagree only on two publishers' builds of one name in one cache, and nothing unloads an oMLX model. |
| `servedIdForCatalogModel` and `engineModelKey` get an oMLX branch; the other engines are untouched | Every installed check, the puller's `alreadyInstalled`, the router's not-downloaded check, the onboarding profile, the memory manager's residency match and the pool's `oneIdPerModel` go through those two. One change each, not one per caller. |
| Hand apps and requests the name oMLX lists (`handoutIdForCatalogModel`, `OmlxBackend.engineModelId`), not the catalog's | Measured: from the Hugging Face cache, `mlx-community/<name>` is a 404 and `mlx-community--<name>` is the only name; with oMLX's `model_fallback` on it is served by the default model instead, which is worse. Both directory layouts accept the catalog's spelling. Matching alone would have turned "not installed" into a 404 for cache users. |
| `handoutIdForCatalogModel`, `preferredInstalledModel` and the router's `proxyToBackend` apply to oMLX only | The review pointed out that using the shared `servedIdForCatalogModel` there also changed Lemonade rows it lists as `user.<id>`. That is probably better, and nothing here could check it against a live Lemonade, so Lemonade keeps what it had. A test per site fails if the scope widens. |
| `prepareTrackedModel` finds a tracked oMLX row by the name oMLX lists | Apps are now handed that name and send it. Without this it never resolved to the tracked row: no `recordUsage`, no load arbitration. Gated to oMLX rows, like the `:latest` fold beside it is for every engine. |
| `OmlxBackend.listed` is written only by a probe of the configured URL | The review found that a Re-check of another URL (Settings, onboarding) overwrote the one slot, and the next request named the model as the catalog does. |
| `isModelLoaded` stays "listed" | Measured: `/v1/models` lists the discovered models with the same ids before and after the first request (`loaded_count` 0, then 1). `listResident` is the place for real residency, and oMLX does not implement it. |
| The old mocks are replaced, not kept beside the new ones | `['mlx-community/Qwen3-8B-4bit']` as a served id is a shape oMLX does not produce. Tests that passed on it said nothing. Two of them (`app-credentials`) fail on the unfixed base once given the real shape. |
| `bin/agent-validate-shift` was not run as one command | It stops at `lint:ci`, which fails on `origin/dev` with a format error in `packages/backend/build.ts` that is not in this change. Its steps were run one by one. |
| `docs/agent/TEST_INVENTORY.md` is not regenerated | As in earlier worksheets, regenerating pulls unrelated rows into the change. |

## Files touched

- New: `packages/backend/src/common/helpers/omlx-model-id.ts`, `packages/backend/src/common/helpers/__tests__/omlx-model-id.test.ts`.
- `packages/backend/src/modules/inference/`: `model-availability.util.ts`, `backends/omlx.backend.ts`, `inference-env-resolver.ts`, `app-credentials.service.ts`, `inference-router.service.ts`.
- Tests: `omlx.backend.test.ts`, `model-availability.util.test.ts`, `onboarding-profile.test.ts`, `vllm.backend.test.ts`, `app-credentials.service.test.ts`, `inference-env-resolver.test.ts`, `inference-router.service.test.ts`, `model-puller.service.test.ts` (all under `modules/inference/__tests__/`), `modules/hub-pool/__tests__/hub-pool-peer.service.test.ts`, and the catalog guard in `curated-models.test.ts`.
- Docs: `docs/system/backend.md`, this worksheet and its feedback.
- Not touched: the catalog, the pool proxy's request matching, the vision handout, the frontend.

## Tests run

Run on the branch after its last rebase, on `origin/dev` f51536af2 (which carries the catalog refresh and the row checker), with pnpm 11.5.1. The same numbers came out on the previous base, a1704521c, so the later `dev` commits (catalog scripts) changed none of them. `bin/agent-validate-shift` was not run as one command (see Decisions), so its steps were run one by one, on the base and on the branch.

- [x] `pnpm run lint:ci`: fails on `origin/dev` and on the branch with the same single error, a format diff in `packages/backend/build.ts`. Biome is clean on every file this change touches.
- [x] `pnpm run tsc`: passes on both.
- [x] `pnpm run knip:ci`: passes on the branch.
- [x] `pnpm --filter backend run test`, run on its own because `pnpm run test` stops at the first failing package: base 495 files passed, 1 skipped (496); 13,115 tests passed, 2 skipped. Branch 496 files passed, 1 skipped (497); 13,192 tests passed, 2 skipped. One new file and 77 new tests.
- [x] The new and changed tests against an unfixed `origin/dev` (9720c6f67, before the first version of the fix was rebased): 32 fail, plus the new helper file, which cannot import. The failures are the oMLX cases only.
- [x] 16 mutations, one at a time, each undoing one behavior of the fix (the organization compare, the exact cache spelling, the configured-URL-only listing, the scope to oMLX at each site, the tracked-row lookup, each handout, `isModelLoaded`, `auto`, `servedIdForCatalogModel`, `engineModelKey`): a test failed for every one. Two more on the catalog guard (a second organization with an existing model name, a `--` in a repo id): both caught.
- [x] Live: a throwaway oMLX 0.7.3.dev1 over one real 4-bit model in each layout. The ids it listed are in the PR.
- [ ] App run (`pnpm run local`): not run. The change is to matching and naming inside the backend, and the live check above ran against oMLX itself. The Hub was not run against an oMLX.
- [ ] `bin/agent-validate-shift` as one command: see Decisions.

## Open items / handoff

- **Pool-routed requests and handouts.** The pool proxy matches a request's model against each node's advertised ids with `inventoryListsModel`, which knows no engine, and `nodesServing` (`app-model-handout.ts`, also `hub-pool/pool-auto-model.ts`) matches the catalog's spelling exactly. A request or a handout that carries the catalog's `mlx-community/<name>` finds no oMLX node, and an oMLX row is never "served by a node", so the pool handout falls to its `unverified` branch, which hands out the listed name without the catalog row's checks or context cap. It always did. Fixing it means an engine-aware match there and a per-node rewrite of the model on forward, since two nodes can list one model under two names.
- **Untracked rows at the Hub's own `/v1` routes.** `routeChatCompletion`, `routeCompletion` and `routeEmbeddings` look an untracked model up by the name sent, verbatim. A client that sends the catalog's `mlx-community/<name>` for a listed row the Hub does not track gets "not found", as for every engine. The listed name works.
- **Vision handout.** `CI_VISION_MODEL` is still `backendModelId`, without an installed check. Fine for the directory layouts, a 404 from the cache.
- **Aliases.** A model behind a `model_alias` is listed only as the alias and matches nothing. `GET /v1/models/status` (the API key) lists `id`, `model_alias`, `source_repo_id` and `loaded` per model. Reading it would also give real residency. It is a new endpoint dependency, so it was left out.
- **A cold start.** `OmlxBackend.engineModelId` knows the listing only after a probe of the configured server, so a request before the first probe names the model as the catalog does, which the cache layout answers with a 404 (or `model_fallback` answers from its default). The Hub's health polling closes that window.
- **What was measured.** One oMLX version (0.7.3.dev1) on one Mac, one model. The source read says the rules are the same for any model. The review checked each rule against the source independently.

## Reviews run

| Phase | Persona | Model | Notes |
| ----- | ------- | ----- | ----- |
| wrap  | code-quality | Sonnet 5.5 (a separate agent, no shared context, read-only) | 7 findings. Fixed: the match ignored the organization and never tried the exact cache spelling (bug); three "falls back" tests could not tell a fallback from an over-match; no test pinned `num_ctx` for oMLX; the one-slot listing was overwritten by a Re-check; Lemonade rows changed at three call sites with no test; a tracked oMLX row was not found by the name an app sends; wording ("every model oMLX can load", "never lists", "one model to oMLX", the 404 claims without `model_fallback`). Left, and listed above: pool matching, untracked rows at the Hub's `/v1` routes. |
