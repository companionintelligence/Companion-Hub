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

> ⚠️ **No shot has been captured yet.** `assets/shots/` holds a `.gitkeep` and nothing else, so
> every scene currently renders as a branded "capture pending" slate and `npm run check` fails
> with `30 shot file(s) missing`. Bringing the stage up and landing those PNGs is the one thing
> standing between this storyboard and a shippable cut.

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

```bash
npm install
npx playwright install --with-deps chromium
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

Prerequisites: Postgres on `6543` and RabbitMQ on `5672` (`e2e/docker-compose.e2e.yml`
or the service containers in `.github/workflows/e2e.yml`), and a **CI-Marketplace
checkout** — `e2e/start-backend.sh` symlinks `$CI_MARKETPLACE_DIR/apps` into the Hub's
store. Without it `app-details`, `install-dialog`, `running-app` and the installed-app
tiles in `hub-home` have no app info to render, so check for `CI-Marketplace: linked` in
the backend log before capturing rather than discovering four empty screens afterwards.

Locally that checkout is just the sibling clone you already have — point
`CI_MARKETPLACE_DIR` at it. No PAT is involved; capture never runs on a hosted runner.

From the **repo root**:

```bash
export SERVER_IP=localhost FRONTEND_PORT=9091 BACKEND_PORT=3000 API_PORT=3000 \
       MOCK_PORTAL_PORT=4444 CI_CLOUD_URL=http://localhost:4444 \
       POSTGRES_PORT=6543 POSTGRES_USERNAME=companion POSTGRES_PASSWORD=postgres \
       POSTGRES_DBNAME=companiondb RABBITMQ_PORT=5672 RABBITMQ_USERNAME=companion \
       RABBITMQ_PASSWORD=admin JWT_SECRET=e2e-test-secret E2E_TEST=true TZ=UTC \
       DEVICE_ID=test-device-e2e CI_HUB_DATA_DIR=/tmp/ci-hub-e2e \
       CI_MARKETPLACE_DIR="$PWD/../CI-Marketplace"

MOCK_PORTAL_SCENARIO=registered pnpm exec tsx e2e/mock-portal/server.ts &
bash e2e/start-backend.sh &
pnpm run --filter frontend build && pnpm run --filter frontend preview &

# Seed the local admin the storyboard signs in as (test@test.com / password), plus
# three DB-only installed apps. Do NOT clearDatabase() — it deletes schema.appStore,
# and the `ci-marketplace` row is only ever created by registerCloudAppStore() at boot.
pnpm exec tsx -e "
  const f = await import('./e2e/fixtures/fixtures.ts');
  const dbh = await import('./e2e/helpers/db.ts');
  const schema = await import('./packages/backend/src/core/database/drizzle/schema.ts');
  await dbh.seedOrganization(); await f.createTestUser();
  await dbh.db.insert(schema.app).values([
    { status: 'running', config: {}, appStoreSlug: 'ci-marketplace', appName: 'immich' },
    { status: 'running', config: {}, appStoreSlug: 'ci-marketplace', appName: 'jellyfin' },
    { status: 'running', config: {}, appStoreSlug: 'ci-marketplace', appName: 'home-assistant' },
  ]);
"

cd video && npm run capture -- --only login-screen,hub-home,hub-store,store-alternatives,\
app-details,install-dialog,running-app,custom-app-create,port-expose,ai-hardware,\
mcp-tools,hub-settings,hub-settings-security
```

**The two store shots need a real Portal, not the mock.** `/store` opens on the *featured* view,
which is proxied from the Portal (`GET /api/store/listings` → `portal-client.fetchStoreListings`),
**not** from the CI-Marketplace symlink. Against `MOCK_PORTAL_SCENARIO=registered` that returns
two apps (OpenClaw, n8n) for every section and one alternatives row, so `hub-store` and
`store-alternatives` would film a near-empty catalog under captions about breadth and choice.
Either point `CI_CLOUD_URL` at a real Portal for the pass, or enrich `sampleStoreApps` /
`sampleAlternatives` in `e2e/mock-portal/scenarios.ts` first. The symlink still matters — it feeds
the search/category views and the `/store/ci-marketplace/immich` app page that `app-details` and
`install-dialog` land on.

The app rows are deliberately DB-only: `populateAppInfo` falls back to the marketplace
catalog when the installed files are absent
(`packages/backend/src/modules/apps/apps.service.ts`), so `hub-home` gets real tiles and
`running-app` gets a real status pill without a Docker install in flight.

## Three capture passes

Two FTUE shots need Hub state that is mutually exclusive with an operational, onboarded
Hub, so a full capture runs in three passes. They used to be declared and left as
permanent slates; they are filmed now.

| Pass | Shots | Setup |
|---|---|---|
| 1 | everything except the two below | the seed above |
| 2 | `onboarding-wizard` | `setWelcomeSeen(false)` (`e2e/helpers/settings.ts`) re-arms the wizard, which `onboarding-page.tsx` otherwise skips whenever `hasCompletedOnboarding` is true. Each pass gets a fresh BrowserContext, so this shot carries its own login in `before`. |
| 3 | `device-registration` | flip the mock portal with `curl -X POST localhost:4444/___control -d '{"scenario":"unregistered"}'`, then `freshUnregistered()` (`e2e/fixtures/hub-states.ts`) clears the DB and removes the tunnel token `start-backend.sh` wrote. **Must run last** — it destroys the seeded admin. Do not reach for `POST /api/registration/prepare-fresh`; it refuses while the Hub is operational. |

Pass 1 is every shot id in `storyboard.json` except those two — the `--only` list in the
command above. Add a scene, add its id there.

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
changed. As of this commit the directory is still empty; see the warning at the top.

`out/` is **not** committed, and the MP4s are not stored anywhere else either — no artifacts, no
release assets. Re-render from the committed shots whenever you need a cut.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
