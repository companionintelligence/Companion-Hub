# Companion Hub — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Hub's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

## Videos are built locally, on demand

There is **no GitHub Actions workflow, no schedule, and no stored MP4** for this video. A cut is
a *build output*: render one when you need it, then delete it. Nothing here is an artifact, a
release asset, or a committed `.mp4`.

What is *meant* to be committed is the input — the screenshots under `assets/shots/`. Once they
exist they let anyone render a cut without booting the whole stage, and a moved UI shows up as a
reviewable image diff.

> ⚠️ **26 of 30 shots are captured and committed; 4 render as slates.**
> `install-and-run` and `bring-your-own-app` have no shot in either viewport. Both have a named
> cause — see [Shots that cannot be filmed yet](#shots-that-cannot-be-filmed-yet). **Both are
> product bugs, not stage problems.** Do not "fix" them by seeding a greener status or by
> pointing a shot at a screen that happens to render.
>
> `configure-install` is **no longer** on that list: #1065 fixed the Install dialog's mobile
> width, and `install-dialog.mobile.png` is captured and committed. The landscape frame was
> re-shot in the same pass because #1065 also fixed the domain suffix that used to wrap its
> last two characters onto a second line.
>
> ⚠️ **`/apps/create` now LOADS — the Zod crash is fixed — and `custom-app-create` is still a
> slate, for a different reason.** The two surviving `.omit()`-on-a-refined-schema call sites are
> gone (plus the latent third), and a source-level guard test keeps them gone. Fixing the crash
> revealed a **second, independent product bug underneath it**: the multi-service form's tab bar
> is written in Tabler/Bootstrap class names (`nav nav-underline`, `nav-item`, `nav-link`, `col`)
> that this app has no stylesheet for, so the tab row renders as an unstyled vertical list of
> icons spilling outside the card. That defect was invisible for as long as the route crashed
> before rendering. See the table below.

The runner lives in the **CI-Engineering checkout** beside this one:

```bash
node tools/make-videos.mjs --list           # every product, and whether its video/ is ready
node tools/make-videos.mjs companion-hub    # render this repo's two cuts from the committed shots
```

It resolves `video-kit` straight from the CI-Common checkout on disk — no npm registry, no token.

`--capture` is **not** wired up for Companion Hub yet: our stage is a seeded Hub plus a
CI-Marketplace checkout, which the runner does not script. To re-shoot the UI, bring the stage up
by hand ([below](#the-capture-stage)) and run `npm run capture` in this directory.

## Quick start

> ⚠️ **`npm install` in this directory does not work, and never has.** `package.json` lists the
> private `@companionintelligence/video-kit`, so npm demands a registry token and the install
> fails before Playwright is ever fetched. Install Playwright through a **throwaway manifest**
> instead — a scratch directory whose only dependency is the exact pinned version — and point
> this directory at it:
>
> ```bash
> mkdir -p /tmp/pw && cd /tmp/pw
> printf '{"name":"pw","private":true,"dependencies":{"playwright":"1.62.1"}}' > package.json
> npm install && npx playwright install chromium   # cached under ~/Library/Caches/ms-playwright
> ln -s /tmp/pw/node_modules <this-repo>/video/node_modules
> ```
>
> The version above **must** match the `playwright` pin in `package.json` — see
> [Why Playwright is pinned exactly](#why-playwright-is-pinned-exactly). Repos with a
> `video/make.sh` automate this; Companion Hub does not have one yet.
>
> Then drive the kit from the CI-Common checkout rather than `npm run`, so the scripts resolve:
>
> ```bash
> node ../../CI-Common/packages/video-kit/bin/ci-video.mjs <doctor|capture|build|check|render>
> ```
>
> **Check the kit version next to that bin before trusting a render** —
> `node -e 'console.log(require("…/video-kit/package.json").version)'`. A CI-Common clone parked
> on an old branch renders last week's brand with no warning. `package.json` here still declares
> `"@companionintelligence/video-kit": "^0.1.0"` while the fleet renders on **0.7.0**; that range
> is stale and is not what the commands above use.

```bash
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the capture stage up (see below):
npm run capture       # drive the real UI -> assets/shots/*.png (both viewports)
npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-hub-landscape.mp4 and out/ci-hub-portrait.mp4
```

`build`, `check` and `render` work without a stage — uncaptured shots render as branded
"capture pending" slates. Only `capture` needs the app running.

## The capture stage

The stage is this repo's own Playwright E2E stage: **mock portal + backend + frontend
PREVIEW build**, i.e. the three entries in `playwright.config.ts` → `webServer[]`. The
preview build (not `dev`) is what `playwright.config.ts` already selects under CI —
no HMR client, no dev overlay, so a rerun on unchanged UI is byte-identical.

Prerequisites: Postgres and RabbitMQ (`e2e/docker-compose.e2e.yml` or the service
containers in `.github/workflows/e2e.yml`), and a **CI-Marketplace checkout** —
`e2e/start-backend.sh` symlinks `$CI_MARKETPLACE_DIR/apps` into the Hub's store. Without
it `app-details`, `install-dialog` and the installed-app tiles in `hub-home` have no app
info to render, so check for `CI-Marketplace: linked` in the backend log before capturing
rather than discovering four empty screens afterwards.

Locally that checkout is just the sibling clone you already have — point
`CI_MARKETPLACE_DIR` at it. No PAT is involved; capture never runs on a hosted runner.

Ports below are the video stage's own (`9191`+) so a capture never collides with a Hub or
an E2E run already using the defaults. From the **repo root**:

```bash
export NODE_ENV=development E2E_TEST=true TZ=UTC \
       SERVER_IP=localhost FRONTEND_PORT=9191 BACKEND_PORT=9192 API_PORT=9192 \
       MOCK_PORTAL_PORT=9193 CI_CLOUD_URL=http://localhost:9193 \
       POSTGRES_HOST=localhost POSTGRES_PORT=9194 POSTGRES_USERNAME=companion \
       POSTGRES_PASSWORD=postgres POSTGRES_DBNAME=companiondb \
       RABBITMQ_HOST=localhost RABBITMQ_PORT=9195 RABBITMQ_USERNAME=companion \
       RABBITMQ_PASSWORD=admin JWT_SECRET=e2e-test-secret \
       DEVICE_ID=test-device-e2e \
       CI_HUB_DATA_DIR=/tmp/ci-hub-video \
       CI_HUB_APP_DATA_DIR=/tmp/ci-hub-video/app-data \
       CI_HUB_APP_DATA_PATH=/tmp/ci-hub-video \
       CI_HUB_TUNNEL_DIR=/tmp/ci-hub-video/tunnel \
       ROOT_FOLDER_HOST=/tmp/ci-hub-video CI_HUB_APP_DIR="$PWD" \
       CI_HUB_FORWARD_AUTH_URL=http://localhost:9192/api/auth/traefik \
       CI_MARKETPLACE_DIR="$PWD/../CI-Marketplace" \
       MOCK_PORTAL_OPERATOR_EMAIL=owner@acme.com MOCK_PORTAL_OPERATOR_PASSWORD=password

docker run -d --name hub-video-pg -p 9194:9194 -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=companion -e POSTGRES_DB=companiondb postgres:14 -p 9194
docker run -d --name hub-video-mq -p 9195:5672 -e RABBITMQ_DEFAULT_USER=companion \
  -e RABBITMQ_DEFAULT_PASS=admin rabbitmq:4-alpine

MOCK_PORTAL_SCENARIO=registered pnpm exec tsx e2e/mock-portal/server.ts &
bash e2e/start-backend.sh &

# Build @ci-hub/common BEFORE the frontend, and do not race them — see the warning below.
pnpm run --filter @ci-hub/common build
pnpm run --filter frontend build && pnpm run --filter frontend preview &
```

**Those first two lines are not optional, and neither is the ordering below them.**

`NODE_ENV` and the four `CI_HUB_*` path vars must be in the **process environment**, not only in
the `$CI_HUB_DATA_DIR/.env` that `start-backend.sh` writes. `packages/backend/src/common/constants.ts`
reads `process.env` at *module load*, before that file is parsed:

```ts
export const APP_DATA_DIR = process.env.CI_HUB_APP_DATA_DIR || '/app-data';   // constants.ts:37
```

Omit them and the backend dies on `ENOENT: no such file or directory, mkdir '/app-data'`. Omit
`NODE_ENV=development` and `DatabaseService.getMigrationsPath()` skips its dev branch and looks in
`$CI_HUB_APP_DIR/assets/migrations`, which does not exist in a source checkout — the backend dies on
`Can't find meta/_journal.json file`. `playwright.config.ts` → `backendEnv` passes all of this
explicitly (`NODE_ENV: 'development'` at line 20); this block is the hand-run equivalent and must
stay in step with it.

```bash

pnpm exec tsx video/stage/seed.mts        # org, operator, installed-app rows, MCP keys

cd video && APP_URL=http://localhost:9191 npm run capture -- \
  --only login-screen,hub-home,hub-store,store-alternatives,app-details,install-dialog,\
port-expose,ai-hardware,mcp-tools,hub-settings,hub-settings-security
```

**Never let the frontend build race `start-backend.sh`.** That script builds `@ci-hub/common`
partway through its own run. Backgrounding it and building the frontend at the same time — the
obvious way to read the block above — compiles the frontend against **whatever `packages/common/dist`
happened to be on disk at that moment**, which in a fresh worktree is the previous commit's. The
capture then films a bundle that is not the tree you checked out, and nothing anywhere reports it:
the shots look plausible, `capture` exits 0, and `check` passes.

This cost a full diagnostic detour on the pass that added `install-dialog.mobile.png`: `/apps/create`
threw the *exact* Zod error #1065 had already fixed, from a bundle seven minutes older than the
`@ci-hub/common` build. Compare mtimes before believing any frame:

```bash
stat -f "%Sm %N" -t "%F %T" packages/common/dist/schemas/dynamic-compose.js \
                            packages/frontend/dist/client/index.html   # frontend MUST be newer
```

`MOCK_PORTAL_OPERATOR_EMAIL` is not optional. Hub login is **Portal-backed** —
`AuthService.login` never checks the local password column, it POSTs the credentials to the
Portal's `/api/auth/sign-in/email` and only then mints a session. The mock portal grew that
route (and `/api/devices/check-in`, whose absence drove the Hub into the `degraded`
provisioning phase after three failures) in the same change that landed these shots; it
accepts the e2e `test@test.com` user plus whatever pair those two env vars name.

**Re-run `video/stage/seed.mts` immediately before each pass.** `app.service.ts` publishes
`sync_app_statuses` on a five-minute cron and AppStatusSyncService flips every app with no
matching Docker container to `missing`, which empties `hub-home`'s tile row. The seed script
is idempotent and re-arms the rows.

**The seed also mints two MCP API keys**, because `mcp-tools` used to lead with "Active keys: 0"
above a catalogue of twenty working tools — an appliance nobody has ever connected anything to.
They are real rows written the way `ApiKeyService.create` writes them (32 random bytes, hex,
SHA-256, only the hash stored); the raw values are generated inside the seed process and never
printed or returned, so no usable credential exists anywhere. Nothing credential-shaped is
invented and no key string appears in this repo or in any frame.

**The store shots are shot against a recording, not the mock portal.** `/store` opens on the
*featured* view, proxied from the Portal (`GET /api/store/listings` →
`portal-client.fetchStoreListings`), **not** from the CI-Marketplace symlink. The mock portal
answers every query with the same two stub apps. `capture.config.mjs` therefore fulfils
`/api/store/listings` and `/api/store/alternatives` from `fixtures/portal-store-*.json`,
which are recordings of the live production Portal (`https://hub.ci.computer/api/store`, a
public endpoint) — real app names, real descriptions, real counts, stable bytes. Re-record
with `node video/fixtures/record-portal-store.mjs`. The symlink still matters: it feeds the
search/category views, the `/store/ci-marketplace/immich` page, and every card icon
(`/api/marketplace/apps/<urn>/image`).

The installed-app rows are deliberately DB-only: `populateAppInfo` falls back to the
marketplace catalog when the installed files are absent
(`packages/backend/src/modules/apps/apps.service.ts`), so `hub-home` gets real tiles without
a Docker install in flight. Immich is **not** among them — `app-details` and `install-dialog`
film its *store* page, and the header swaps Install for Open the moment it is installed.

## Shots that cannot be filmed yet
<a id="shots-that-cannot-be-filmed-yet"></a>

| Shot | Scene | Why it is a slate |
|---|---|---|
| `running-app` | `install-and-run` | The caption promises a green badge. A DB-seeded `running` app cannot produce one: `getAppStatusPresentation` downgrades it to an amber, animated **Initializing** whenever runtime health reports zero containers. A genuine install is not available either — `installApp` → `ReposHelpers.downloadAppFiles` pulls the bundle from the **Portal** (`/api/store/:id/install`, device-authenticated), and the mock portal answers 404 (`Failed to fetch app files`). Needs a pass with a real Portal install bundle and a real container. |
| `custom-app-create` | `bring-your-own-app` | **The route loads now; the screen is not yet publishable.** The Zod crash is fixed — all three `.omit()`-on-a-refined-schema call sites (`components/multi-service-form/json-compose-editor.tsx:11` at module scope, `stores/multiServiceStore.ts:64`, `modules/app/pages/custom-app-edit-page.tsx:50`) now use `dynamicComposeFormSchema`, and `components/multi-service-form/compose-schema-usage.test.ts` fails the build if any of them comes back. What blocks the shot now is a **separate styling bug**: `components/multi-service-form/multi-service-form.tsx:211` builds the service tab bar from Tabler/Bootstrap classes — `<ul class="nav nav-underline …">`, `nav-item`, `nav-link`, `nav-link-icon`, `nav-link-title`, `col` — and **this app has no Tabler or Bootstrap dependency and no stylesheet defining them** (`grep nav-underline packages/frontend/dist/client/assets/*.css` returns nothing; the `<ul>` computes to `display: block`). The tabs therefore stack vertically as bare icons + labels, left-aligned outside the card's padding, and the Compose editor the caption promises is pushed off-frame. Filming that under "Bring your own containers. They become a real app." would ship a broken-looking product. Restyle the tab bar in the app's own Tailwind/shadcn idiom — a design call, not a mechanical one — then `capture --only hub-home,custom-app-create` (`hub-home` first: it carries the login, see hazard 7). |

## Three capture passes

Two FTUE shots need Hub state that is mutually exclusive with an operational, onboarded
Hub, so a full capture runs in three passes. They used to be declared and left as
permanent slates; they are filmed now.

| Pass | Shots | Setup |
|---|---|---|
| 1 | everything except the two below, minus the two slates | `video/stage/seed.mts`, re-run immediately before the pass |
| 2 | `onboarding-wizard` | `setWelcomeSeen(false)` (`e2e/helpers/settings.ts`) re-arms the wizard, which `onboarding-page.tsx` otherwise skips whenever `hasCompletedOnboarding` is true. Each pass gets a fresh BrowserContext, so this shot carries its own login in `before`. |
| 3 | `device-registration` | flip the mock portal with `curl -X POST localhost:9193/___control -d '{"scenario":"unregistered"}'`, then `freshUnregistered()` (`e2e/fixtures/hub-states.ts`) clears the DB and removes the tunnel token `start-backend.sh` wrote. **Must run last** — it destroys the seeded admin. Do not reach for `POST /api/registration/prepare-fresh`; it refuses while the Hub is operational. |

Pass 1 is every shot id in `storyboard.json` except those two and the two in
[Shots that cannot be filmed yet](#shots-that-cannot-be-filmed-yet) — the `--only` list in
the command above. Add a scene, add its id there.

## Screens deliberately left out

Not every route belongs in the cut. These were considered and rejected, with the reason,
so nobody re-adds them as a shot that can only ever render a slate:

| Screen | Why not |
|---|---|
| `/connect` | Only renders inside the Tauri mobile shell — `connect-page.tsx`'s loader redirects off-mobile and the component returns `null` when `!isTauriMobileSync()`. Filming it needs a simulator-based capture stage, which is a different project. |
| `/restore-apps` | A recovery interstitial, not a major screen. Reaching it needs a recorded restore intent from a re-pair against a portal that already owns apps. |
| Settings → Logs | `LogsContainer` streams live backend log lines over SSE, so the shot would differ on every capture and show up as permanent, meaningless churn in `assets/shots`. Masking the terminal leaves an empty black rectangle. |
| An `installing → running` transition | The kit captures still PNGs (`page.screenshot`); there is no video capture path, so no narration should imply motion inside a shot. |
| `/resource-monitor` | Cut. Its totals are summed from live container stats, and the documented stage seeds DB rows with no Docker install in flight — so every column reads `0.0% / 0 B / 0 containers` and the chart shows "Collecting enough samples". A caption promising live per-app CPU over a table of zeros is a false claim. Re-add it only alongside a pass that runs at least one genuinely installed app. |
| The installed app's own UI on its own hostname | The reference cut's payoff beat (`videos/ci-tutorial-video/storyboard/v2/scenes-v2.json` → `c4-store-live`, "Read the URL bar"). It is the strongest shot this video does not have, and it needs a real container behind Traefik on a real domain with real content in it — a materially bigger stage than everything above. Worth building; not something to declare as a shot that can only render a slate. |

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, `npm run capture -- --only <id>`,
then `npm run build && npm run render`.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`assets/audio/*.mp3` **are** committed — one per scene with a `narration` field, regenerated with
`npm run narrate` whenever that string changes.

`assets/shots/*.png` **belong** here too and are committed *once captured* — they are the record
of what the product looked like, and captures are byte-stable, so a diff in them means the UI
genuinely changed. Review that diff and update `storyboard.json` captions if a screen's meaning
changed.

`fixtures/portal-store-*.json` are committed too. They are recorded Portal responses, not
hand-written data — regenerate them with `node fixtures/record-portal-store.mjs` rather than
editing them, and expect the diff to be large when the catalog grows.

`out/` is **not** committed, and the MP4s are not stored anywhere else either — no artifacts, no
release assets. Re-render from the committed shots whenever you need a cut.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.

## Why Playwright is pinned exactly

`video/package.json` pins `playwright` to an exact version, not a range.

Captures are byte-stable — that is what makes committing the shots worthwhile, because a UI change
then lands as a reviewable image diff instead of noise. But that property only holds **within one
Chromium build**. A `^1.58.0` range resolved to 1.62.1 on one machine and rewrote every committed
shot in a repo by 0.07–0.47% of pixels: pure text antialiasing, no layout change, and completely
indistinguishable from a real UI change in review.

So the range is gone. Re-pin deliberately when you want the newer browser, and re-capture the whole
shot set in the same commit.
