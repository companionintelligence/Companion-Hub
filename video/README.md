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
checkout beside this repo** — `e2e/start-backend.sh` symlinks `$CI_MARKETPLACE_DIR/apps`
into the Hub's store, and without it the store and app-detail shots film an empty grid.

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

# seed the local admin the storyboard signs in as (test@test.com / password)
pnpm exec tsx -e "
  const f = await import('./e2e/fixtures/fixtures.ts');
  const db = await import('./e2e/helpers/db.ts');
  await db.clearDatabase(); await db.seedOrganization(); await f.createTestUser();
"

cd video && npm run capture
```

`.github/workflows/video.yml` runs exactly this. Point `APP_URL` at something else if
you are capturing a real appliance instead.

## Shots that cannot be captured from this stage

Three shots stay pending on the default stage, because each needs Hub state that is
mutually exclusive with the rest of the run. They are declared in the storyboard so the
cut is complete, and render as slates until someone films them:

| Shot | Why |
|---|---|
| `device-registration` | `root.tsx`'s loader sends an operational Hub from `/device-registration` to `/login`. Needs `MOCK_PORTAL_SCENARIO=unregistered` and no tunnel token. |
| `onboarding-wizard` | `onboarding-page.tsx` redirects to `/home` when `hasCompletedOnboarding` is true — which is exactly what the seeded admin needs to be for every other shot. |
| `app-installing` | Needs a real Docker install in flight. No app is installed on the stage, so `[data-testid="app-status-pill"]` never appears. |

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
