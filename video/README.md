# Companion Hub product video

This directory contains the active HyperFrames build. For archived tutorial reference material, see [`../videos/`](../videos/).

This build generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Hub from
this repository's UI. Both cuts use [`storyboard.json`](storyboard.json).

## Videos are built locally, on demand

There is **no GitHub Actions workflow, no schedule, and no stored MP4** for this video. A cut is
a *build output*: render one when you need it, then delete it. Nothing here is an artifact, a
release asset, or a committed `.mp4`.

What is *meant* to be committed is the input — the screenshots under `assets/shots/`. Once they
exist they let anyone render a cut without booting the whole stage, and a moved UI shows up as a
reviewable image diff.

> ⚠️ **The root [`README.md`](../README.md) embeds eight of these shots** in its screenshot grid —
> `onboarding-wizard`, `ai-models`, `hub-store`, `store-alternatives`, `running-app`, `app-hermes`,
> `mcp-tools`, and `custom-app-create` (the desktop PNGs) — so a re-shoot updates the README too.
> `hub-store`, `mcp-tools`, and `custom-app-create` are not in the current storyboard, so a
> default `make.sh` pass does not re-shoot them; use the longer `--only` list below. Renaming or
> deleting any of the eight breaks the README; update its grid in the same change.
>
> **One cut is committed, outside this directory, on purpose.** The README's hero plays
> [`docs/images/readme/hub-tour.webp`](../docs/images/readme/hub-tour.webp), a silent loop, and
> links to [`docs/images/readme/hub-tour.mp4`](../docs/images/readme/hub-tour.mp4), the
> `ci-hub-30` short with sound. GitHub has no way to host a README video from a build, so these
> two files are the exception to the rule above. Refresh them after a storyboard change —
> the WebP is 4.0 s to 20.8 s of the short at 960 px, 12 fps; the MP4 is the whole short at 720p:
>
> ```bash
> # from the CI-Engineering checkout
> node tools/make-videos.mjs companion-hub --format landscape --kit checkout --out /tmp/hub-cuts
> V=/tmp/hub-cuts/companion-hub/ci-hub-30-landscape.mp4
> mkdir -p /tmp/hub-frames
> ffmpeg -ss 4.0 -t 16.8 -i "$V" -vf "fps=12,scale=960:-1:flags=lanczos" /tmp/hub-frames/f%03d.png
> img2webp -loop 0 -lossy -q 72 -m 6 -d 83 /tmp/hub-frames/f*.png -o docs/images/readme/hub-tour.webp
> ffmpeg -i "$V" -vf "scale=1280:-2:flags=lanczos" -c:v libx264 -preset slow -crf 23 \
>   -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k docs/images/readme/hub-tour.mp4
> ```
>
> `--kit checkout` is there because, as of 2026-09-27, CI-Common `origin/main` ships the kit CLI as
> `bin/ci-video.ts` while `make-videos.mjs` still looks for `bin/ci-video.mjs`, so the default
> `--kit origin` fails preflight.

Every shot the storyboard references is captured (0 slates). The cut is **16 scenes**
and references **8 shot ids × 2 viewports**.

> ⚠️ **Nine shot ids are committed and are NOT in the current cut.** They are kept, not deleted,
> and that is a deliberate deviation from the house rule that a dropped scene takes its PNGs with
> it (see CI-Spellbook #52/#53 and CI-Web-XR-Scan #50). The reason: none of them was dropped for a
> defect — the storyboard was rewritten around a new script that simply does not have a beat for
> them — and two of them (`running-app`, `custom-app-create`) cost four product PRs and a real
> four-container Immich install to unblock. They cost nothing at render time and `shot-coverage`
> caps `have` at `need`, so they do not distort any fleet count.
>
> | Parked shot | What it is | Why it is out of this cut |
> |---|---|---|
> | `login-screen` | The local login form | The script opens on the problem, not on signing in |
> | `device-registration` | The six-character pairing step | No pairing beat in the script |
> | `app-details` | Immich's store page + App Privacy card | The App Privacy beat is cut — see below |
> | `running-app` | Immich with a genuine green Running pill | No "it is live" beat; the strongest orphan here |
> | `custom-app-create` | Bring-your-own-container form | No BYO beat in the script |
> | `mcp-tools` | MCP server, keys and tool catalog | No agent-plumbing beat |
> | `hub-settings`, `hub-settings-security` | The settings tab row and Security tab | The old cut ended a chapter on a settings page; the new one does not |
>
> ⚠️ **The App Privacy beat is gone.** It is not in the current script, and CI-Engineering's
> `tools/EDITORIAL-REVIEW.md` finding 2 recommends dropping it outright: the card renders
> unconditionally but its contents are a fixed i18n constant, zero of the 512 CI-Marketplace
> manifests carry a privacy field, and `privacy_labels` on the Portal's `AppEntity` is never
> populated. `app-details.png` stays on disk as the record of that screen.

The runner lives in the **CI-Engineering checkout** beside this one:

```bash
node tools/make-videos.mjs --list           # every product, and whether its video/ is ready
node tools/make-videos.mjs companion-hub    # render this repo's two cuts from the committed shots
```

It resolves `video-kit` straight from the CI-Common checkout on disk — no npm registry, no token.

**To re-shoot, use this repo's own runner** — one command, which stands the whole stage up,
shoots it in two passes and takes it down again:

```bash
./video/make.sh --no-render          # stage, capture, check (no render — much faster)
./video/make.sh                      # …and render both cuts
./video/make.sh --only hub-home      # re-shoot one shot against a stage you already have up
./video/make.sh --keep-up            # leave the stage running afterwards
```

`--capture` on `make-videos.mjs` is **refused, not missing**: that runner renders from a
`git archive` export, and staging an app is not a single shell command — which is why capture
belongs to each repo. Companion Hub had no such command until [`video/make.sh`](make.sh) and
[`video/stage.sh`](stage.sh) landed, and in the meantime an *App Privacy* fix merged while the
committed footage still showed the old card.

**What `stage.sh` shoots is the cut**: the nine shot ids the current `storyboard.json` references.
The nine **parked** ids listed above — `running-app` among them — are *not* re-shot, deliberately.
`running-app` needs a genuine four-container Immich install, and installing Immich also swaps the
store page's Install button for Open, which would change `install-dialog`. Re-shooting those is a
separate, explicit act; the steps are still below.

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
> [Why Playwright is pinned exactly](#why-playwright-is-pinned-exactly). **`video/make.sh` now
> automates all of this** — it installs the pinned Playwright through a throwaway manifest into
> `video/node_modules` and resolves the browser through the kit, so the block above is only for
> driving the pieces by hand.
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
> `"@companionintelligence/video-kit": "^0.1.0"` while the fleet renders on **0.13.1**; that range
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
  --only hub-home,ai-hardware,install-dialog,port-expose,store-alternatives,app-hermes,app-openclaw
```

That list is **the shots the current storyboard needs**, minus the two FTUE shots below. The nine
parked ids are not re-shot by it; re-shooting them needs the longer list this file used to carry —
`login-screen,hub-store,app-details,mcp-tools,hub-settings,hub-settings-security,running-app,custom-app-create`
— plus a genuine Immich install for `running-app`.

**Re-run `video/stage/seed.mts` immediately before the pass, and capture `hub-home` first.**
This is the five-minute `sync_app_statuses` cron, and its symptom has changed since this file last
described it: it no longer *empties* the tile row. It now leaves the three tiles in place and
overlays a **red error badge on each app logo**, which is a frame that still renders, still passes
`check`, and still looks like three broken images to anyone reading a contact sheet. Measured here:
a `hub-home` captured six minutes after the seed came back SSIM 0.9968 against the good frame — a
difference small enough to skim past in a diff and fatal on screen. Re-seed, then shoot it.

**`hub-home` no longer logs in through the form.** It used to `fill`/`click` its way through
`/login`, which only works as the first authenticated shot of a pass — `/login`'s clientLoader
redirects a signed-in visitor to `/home`, so once any earlier shot had authenticated, `hub-home`
timed out waiting for an email field that would never appear. It now uses the idempotent
`POST /api/auth/login` + `location.assign` shape this file recommends for every new shot, so it
works anywhere in the order. `onboarding-wizard` still uses the form shape, and still must be
pass 2.

`running-app` additionally needs Immich genuinely installed and up before the pass. It is
the one shot with a prerequisite the storyboard cannot express, so do it explicitly and
check the containers rather than trusting the API's 201:

```bash
curl -s -c /tmp/hub.jar -X POST http://localhost:9192/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"owner@acme.com","password":"password"}'
curl -s -b /tmp/hub.jar -X POST 'http://localhost:9192/api/app-lifecycle/immich:ci-marketplace/install' \
  -H 'Content-Type: application/json' -d '{"port":9008,"exposedLocal":false,"exposed":false}'
# install is async — wait for all four, and for HEALTHY, not merely Up
docker ps --filter name=immich --format '{{.Names}} {{.Status}}'
```

`app-details` and `install-dialog` film Immich's **store** page and need its Install button,
which the header swaps for Open the moment Immich is installed. So either capture those two
before installing, or leave them alone — they are already committed. `--only` scoped to
`running-app,custom-app-create` does not touch them.

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

**None.** All 17 shot ids on disk are filmed — the 8 this cut uses and the 9 parked ones. Both entries that used to live
here — `running-app` and `custom-app-create` — were captured on 2026-08-07; what it took
is recorded below, because both were blocked by something real rather than by effort.

| Shot | Was blocked by | Unblocked by |
|---|---|---|
| `running-app` | The caption promises a green badge, and a DB-seeded `running` app cannot produce one — `getAppStatusPresentation` downgrades it to an amber, animated **Initializing** whenever runtime health reports zero containers. A genuine install was not available either: `installApp` → `ReposHelpers.downloadAppFiles` fetches the bundle from the **Portal**, and the mock portal answered 404 (`Failed to fetch app files`). | `e2e/mock-portal/server.ts` grew the missing `GET /api/store/:slug/install` route, serving `config.json` + `docker-compose.json` **off the CI-Marketplace checkout it already symlinks** — the same two files production's `GetInstallBundle` returns. Immich then installs for real: four containers (`immich-server`, `-machine-learning`, `-redis`, `-db`), all healthy, `AppMonitor` reporting live CPU for them. The pill is `bg-green-500` because the app is genuinely up, not because anything was seeded greener. |
| `custom-app-create` | The Zod crash (#1065/#1070), then the Tabler/Bootstrap tab bar with no CSS behind it (#1071) — tabs stacked vertically as bare icons outside the card's padding. | **#1074**, which restyled the tab bar in the app's own Tailwind idiom. The shot now shows a horizontal tab bar with a visible active pill, the two-column services layout, and one panel at a time. |

**`running-app` needs a real Docker runtime on the capture host** (colima on macOS). Without
one the install still fails, just later and louder. Budget a few minutes for the first pass:
Immich's four images are pulled for real.

## Three capture passes

Two FTUE shots need Hub state that is mutually exclusive with an operational, onboarded
Hub, so a full capture runs in three passes. They used to be declared and left as
permanent slates; they are filmed now.

| Pass | Shots | Setup |
|---|---|---|
| 1 | everything except the two below | `video/stage/seed.mts`, re-run immediately before the pass — plus a genuine Immich install for `running-app` (see above) |
| 2 | `onboarding-wizard` | `setWelcomeSeen(false)` (`e2e/helpers/settings.ts`) re-arms the wizard, which `onboarding-page.tsx` otherwise skips whenever `hasCompletedOnboarding` is true. Each pass gets a fresh BrowserContext, so this shot carries its own login in `before`. |
| 3 | `device-registration` | flip the mock portal with `curl -X POST localhost:9193/___control -d '{"scenario":"unregistered"}'`, then `freshUnregistered()` (`e2e/fixtures/hub-states.ts`) clears the DB and removes the tunnel token `start-backend.sh` wrote. **Must run last** — it destroys the seeded admin. Do not reach for `POST /api/registration/prepare-fresh`; it refuses while the Hub is operational. |

Pass 1 is every shot id in `storyboard.json` except those two — the `--only` list in the
command above. Add a scene, add its id there.

**Both pass-1 shots added in the 30/30 pass log themselves in.** `running-app` and
`custom-app-create` do not inherit the session from `hub-home`'s `before` block the way the
rest of pass 1 does: each starts at its own route, waits on `<its own selector>, input[placeholder='you@example.com']`
(a CSS selector list, so it resolves whether the Hub answers with the page or the login
gate), then logs in over `POST /api/auth/login` in an `eval` and navigates. That is
idempotent — it works as shot #1 of a fresh context and as shot #11 of a warm one. Prefer
this shape for any new shot. A `--only` run that silently inherits state from the shots that
would have preceded it is how this fleet once filmed an entire room behind an
"Enable Microphone" modal, with `check` passing it twice.

## Two disclosures about what is on screen

**`install-dialog` and `port-expose` are shot with "This Machine Only" selected, and that is not
the form's default.** `resolveExposureMode` (`modules/onboarding/helpers/agent-onboarding.ts:48`)
returns `cloudflare` whenever a Cloudflare domain is configured, so on a Hub with a domain — which
the stage has — **the install form opens on Public Web**. Both shots therefore carry a
`{"click": "button:has-text('This Machine Only')"}` step in their `before` block.

That is a real state a user chooses, not a fixture, and it is the state the film's line is about
("Apps arrive already configured. Already private."). The previous captures had Public Web selected
and a public `*.ci.computer` subdomain filled in — a frame that says the opposite of the line over
it, which is the one combination the honesty bar forbids. Nothing here should be read as a claim
that local-only is the default; **it is not**, and that is worth a product conversation rather than
a caption. Note also that Private VPN renders disabled on this stage because no Tailscale transport
is configured for it.

**`split` was tried for the Hermes/OpenClaw beat and rejected, with a measurement.** `split` is
used by zero films in the fleet, and pairing the two app pages in one frame is exactly what it is
for. In portrait it does not work: `brand.mjs` styles `.shot` as `object-fit: cover` with
`object-position: top center`, and a `split` cell is 16:9, so a 1080×1920 mobile plate is
cover-cropped to its **top 31.6%** — which on a Hub app page is the header and the app icon and
stops roughly 80px above the app's *name*. The portrait cut would have shown two icons and no
names, under a line that names both apps. The beat is two sequential shots inside one `screen`
scene instead. `split` remains available and remains unused; anyone reaching for it should shoot
a 16:9-safe subject or expect the top-crop.

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

## The 30-second cut and the 6-second bumpers

They are written and they are **not rendered by anything**, on purpose. The copy is parked at the
bottom of this section so it is not lost; here is why it is parked rather than built.

**The pipeline produces one film per product, in two formats, from one `storyboard.json`.** A
30-second cut and three 6-second bumpers are four more deliverables it has no mechanism for. Three
routes were considered:

| Route | Verdict |
|---|---|
| Extra entries in `CI-Engineering/tools/stages.json` | **Wrong.** An entry is `{name, repo, capture, comment}` — there is no field naming *which* storyboard, so `companion-hub-30s` would resolve `CI-Hub` `origin/dev`'s one `video/storyboard.json` and render the same film again. It also corrupts every fleet count that iterates those keys: `shot-coverage`, `score-videos` ("24/24") and `build-gallery` would grow eight derivative rows. And `lib/bar.mjs` has **one** bar with `duration: [45, 105]`, so three 6-second bumpers are three permanently-red rows in a fleet whose whole point is that red means something. |
| A kit feature | **Right shape.** A `cuts` block in the storyboard — named scene-id lists, each rendering its own pair of MP4s (`ci-hub-short-landscape.mp4`) — keeps one shot set, one `narration.json` and one place a line can drift. It needs schema, `layout()` filtering, per-cut render targets, and a per-cut duration bar so a bumper is judged as a bumper. That is a kit PR with its own version bump and a fleet re-render. |
| Out of scope for this pass | **What was done.** |

Two things a `cuts` implementation must handle, found while reading the script against the kit:

- **The 30-second cut is different prose, not a subset of the long film's lines.** Under
  `meta.pacing: "fit"` a scene is sized by its own mp3, so a short cut cannot be assembled by
  dropping scenes — it needs its own scenes and its own recordings. `cuts` should therefore name
  scene ids and let scenes exist that no other cut uses.
- **A 6-second bumper has no room for a `screen` scene.** Each is one card and one line; they are
  authoring work, not plumbing, and they need their own outro CTA handling (the kit requires a
  `cta` on every `outro` and there is no room for a separate outro in six seconds).

### The copy, verbatim, for whoever builds it

**30-second cut.** "It starts as a good idea. A home server. Three weekends later there is a reverse
proxy, a wiki tab that never closed, and a machine that dies when the lights blink. There is a much
shorter way. Companion Hub turns a computer already sitting around into a private AI server. One
installer, one wizard. It reads the hardware and picks the models that run fast on it. Apps arrive
configured. A phone connects, without exposing anything to the internet. The files stay in the
house. Companion Hub. Uncloud your life."

**6-second bumpers.** 1. "That old laptop is a server now." 2. "Stop renting what could be owned."
3. "Local AI. One roof. No landlord."

Note for the 30-second cut when it is built: *"a machine that dies when the lights blink"* is a
power-flicker beat this pipeline cannot photograph, and *"a wiki tab that never closed"* needs a
browser tab strip the `screen` renderer does not draw. Both are typographic beats or they are cut —
the same call made for the long film's cold open.

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
