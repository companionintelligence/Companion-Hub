# Companion Hub — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Hub's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

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
tiles in `hub-home` have no app info to render, and the workflow now fails on that
rather than shipping four slates.

In CI that checkout needs **`secrets.CI_ORG_READ_TOKEN`**, a PAT with read access to the
private CI-Marketplace repo. `secrets.GITHUB_TOKEN` is scoped to CI-Hub and cannot do it.

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
mcp-tools,hub-settings,hub-settings-security,hub-resource-monitor
```

The app rows are deliberately DB-only: `populateAppInfo` falls back to the marketplace
catalog when the installed files are absent
(`packages/backend/src/modules/apps/apps.service.ts`), so `hub-home` gets real tiles and
`running-app` gets a real status pill without a Docker install in flight.

## Three capture passes

Two FTUE shots need Hub state that is mutually exclusive with an operational, onboarded
Hub, so `.github/workflows/video.yml` captures in three passes. They used to be declared
and left as permanent slates; they are filmed now.

| Pass | Shots | Setup |
|---|---|---|
| 1 | everything except the two below | the seed above |
| 2 | `onboarding-wizard` | `setWelcomeSeen(false)` (`e2e/helpers/settings.ts`) re-arms the wizard, which `onboarding-page.tsx` otherwise skips whenever `hasCompletedOnboarding` is true. Each pass gets a fresh BrowserContext, so this shot carries its own login in `before`. |
| 3 | `device-registration` | flip the mock portal with `curl -X POST localhost:4444/___control -d '{"scenario":"unregistered"}'`, then `freshUnregistered()` (`e2e/fixtures/hub-states.ts`) clears the DB and removes the tunnel token `start-backend.sh` wrote. **Must run last** — it destroys the seeded admin. Do not reach for `POST /api/registration/prepare-fresh`; it refuses while the Hub is operational. |

Pass 1 derives its `--only` list from `storyboard.json` so a new scene is picked up
automatically. Only the two FTUE shot ids are named in the workflow.

## Screens deliberately left out

Not every route belongs in the cut. These were considered and rejected, with the reason,
so nobody re-adds them as a shot that can only ever render a slate:

| Screen | Why not |
|---|---|
| `/connect` | Only renders inside the Tauri mobile shell — `connect-page.tsx`'s loader redirects off-mobile and the component returns `null` when `!isTauriMobileSync()`. Filming it needs a simulator-based capture stage, which is a different project. |
| `/restore-apps` | A recovery interstitial, not a major screen. Reaching it needs a recorded restore intent from a re-pair against a portal that already owns apps. |
| Settings → Logs | `LogsContainer` streams live backend log lines over SSE, so the shot would differ on every run and open a `chore/video-shot-refresh` PR every Monday. Masking the terminal leaves an empty black rectangle. |
| An `installing → running` transition | The kit captures still PNGs (`page.screenshot`); there is no video capture path, so no narration should imply motion inside a shot. |

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

`assets/shots/*.png` and `assets/audio/*.mp3` **are** committed — they are the record of what the
product looked like, and captures are byte-stable, so a diff in them means the UI genuinely
changed. `out/` is not committed.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
