/**
 * Capture stage for Companion Hub.
 *
 * `ci-video capture` drives the REAL app through this config. The stage is the
 * repo's own Playwright E2E stage — mock-portal + backend + frontend PREVIEW
 * build — exactly the three servers in `playwright.config.ts` -> `webServer[]`.
 * See video/README.md § "The capture stage" for the boot command. There is no
 * GitHub Actions workflow for this video — captures are run by hand.
 *
 * Why the preview build and not `pnpm run --filter frontend dev`:
 * playwright.config.ts already makes that choice for CI
 * (`process.env.CI ? 'build && preview' : 'dev'`). The preview build has no HMR
 * client, no Vite dev overlay and no on-demand transform, so a rerun on
 * unchanged UI produces identical bytes. Do not point APP_URL at a dev server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DETERMINISM HAZARDS FOUND IN THIS APP (every one of these is handled below or
 * in storyboard.json; the ones that are NOT handled are called out as such):
 *
 * 1. LIVE SYSTEM STATS — packages/frontend/src/modules/dashboard/pages/dashboard.tsx
 *    polls `systemLoadOptions()` with `refetchInterval: 3000`, and
 *    components/layouts/dashboard/layout.tsx polls the SAME query again. Disk,
 *    CPU and memory therefore change every three seconds on every authenticated
 *    page. HANDLED: `/api/system/load` is fulfilled from a pinned fixture below,
 *    so the numbers are stable AND still legible. They are a fixture, not this
 *    machine's real load — the alternative was masking the hero shot's three
 *    stat cards to black rectangles.
 *
 * 2. PERSISTENT SSE — components/routes/authenticated-route.tsx wraps every
 *    authenticated route in <SSEProvider>, which opens an EventSource on
 *    `/api/sse/<topic>` (lib/hooks/use-sse.ts) and never closes it. Playwright's
 *    default `waitUntil: "networkidle"` would therefore NEVER resolve on /home,
 *    /store, /settings or /resource-monitor — the shot would fail at the 45s
 *    goto timeout. HANDLED: every capture in storyboard.json pins
 *    `waitUntil: "domcontentloaded"` and relies on an explicit `waitFor`
 *    selector plus `settle`. The SSE stream is deliberately left alone so we
 *    film the real app rather than a stubbed one.
 *
 * 3. FRAMER-MOTION ROUTE TRANSITIONS — components/layouts/dashboard/layout.tsx
 *    wraps the outlet in <AnimatePresence> with a spring
 *    (`stiffness: 300, damping: 30`). That is a JS-driven transform, so neither
 *    Playwright's `animations: "disabled"` nor the kit's FREEZE_CSS stops it,
 *    and `reducedMotion: "reduce"` does not either (framer-motion only honours
 *    that under <MotionConfig reducedMotion="user">, which this app does not
 *    use). HANDLED: every authenticated shot uses `settle: 1200`, comfortably
 *    past the spring's settle time.
 *
 * 4. RESOURCE MONITOR — NO LONGER SHOT, and the reason is worth keeping.
 *    modules/system/pages/resource-monitor-page.tsx sums its totals from live
 *    container stats (app-runtime-monitor.service.ts -> dockerService
 *    .getAppRuntimeStats). The stage below seeds DB rows only, with no Docker
 *    install in flight, so every column reads 0.0% / 0 B / 0 containers and the
 *    chart falls back to "Collecting enough samples to draw the CPU history
 *    chart." (`history.length < 2`). Its `waitFor` was the <h1>, so nothing
 *    stopped the empty shot from being taken under a caption promising live
 *    per-app CPU and memory. The scene was cut from storyboard.json rather than
 *    shipped as zeros. To bring it back you need at least one genuinely running
 *    installed app during the pass — and then `RESOURCE_MONITOR_LAST_SAMPLED`
 *    ("Last sampled {{time}}") is rendered from the SERVER's timestamp, so
 *    `context.clock.install` will not freeze it and the shot needs
 *    `mask: ["text=Last sampled"]` plus a mask over the volatile CPU/memory
 *    columns.
 *
 * 5. DEVICE ID — the device-registration page prints the Hub's device id.
 *    HANDLED: masked via `text=Device ID`. On the E2E stage it is pinned to
 *    `test-device-e2e` anyway (playwright.config.ts backendEnv.DEVICE_ID).
 *
 * 6. STORE CATALOG DEPTH — NOT HANDLED, and it is a stage prerequisite, not a
 *    code problem. There are TWO catalogs behind /store, and they come from
 *    different places:
 *
 *    a) The DEFAULT view. app-store-page.tsx sets DEFAULT_STORE_CATEGORY =
 *       'featured', and FeaturedStoreView sources all four of its sections from
 *       `portalStoreListingsQueryOptions` -> GET /api/store/listings
 *       (app.controller.ts) -> portal-client.fetchStoreListings -> the PORTAL's
 *       `/store`. On this stage CI_CLOUD_URL=http://localhost:4444, so that is
 *       the mock portal, whose `GET /api/store` handler returns exactly two
 *       apps (ci-openclaw, n8n) and IGNORES the `tags` / `sort` query — all four
 *       sections render the same two cards. `GET /api/store/alternatives`
 *       likewise returns a single row (Notion -> AppFlowy). So `hub-store` and
 *       `store-alternatives` CANNOT be shot honestly against the mock portal:
 *       point CI_CLOUD_URL at a real Portal for the pass, or enrich
 *       `sampleStoreApps` / `sampleAlternatives` in e2e/mock-portal/scenarios.ts
 *       first.
 *
 *    b) The SEARCH / CATEGORY views and the app-detail pages, which read the
 *       Hub's own catalog. `e2e/start-backend.sh` symlinks
 *       `$CI_MARKETPLACE_DIR/apps` (default `../CI-Marketplace`) into
 *       `$CI_HUB_DATA_DIR/repos/ci-marketplace/apps`; without that checkout the
 *       script prints "app store will be empty" and `app-details` /
 *       `install-dialog` FAIL on their waitFor. Check out CI-Marketplace beside
 *       this repo before capturing.
 *
 *    Both shots that land on an app page name Immich explicitly
 *    (`/store/ci-marketplace/immich`) rather than clicking the first store card:
 *    on the mock stage the first card is ci-openclaw, a third-party upstream the
 *    video pipeline's app-matrix excludes.
 *
 * 7. SESSION — there is no storageState file, on purpose. The first authenticated
 *    shot (`hub-home`) performs the real login in its `before` block, and the kit
 *    reuses one BrowserContext and one Page for every shot in a viewport
 *    (src/capture.mjs), so the session cookie carries to /store, /settings and
 *    /resource-monitor. Doing the login in `onContext` instead would break the
 *    `login-screen` shot, because /login's clientLoader redirects a signed-in
 *    visitor straight to /home. The stage must seed the `test@test.com` /
 *    `password` admin (e2e/helpers/constants.ts + e2e/fixtures/fixtures.ts
 *    `createTestUser`) before capture runs.
 *
 *    The two FTUE shots are the exception: `onboarding-wizard` and
 *    `device-registration` are captured in their own later passes with their own
 *    fresh BrowserContext (video/README.md § "Three capture passes"), so
 *    `onboarding-wizard` carries its own login in `before`.
 *
 * 8. HARDWARE PROFILE — the `ai-hardware` shot films the AI tab's hardware card,
 *    which reads `/api/inference/onboarding-profile`. Free RAM and free disk on a
 *    GitHub runner differ on every run, so an untouched capture would produce a
 *    `chore/video-shot-refresh` PR every Monday for two changed numbers — the
 *    same objection that keeps Settings -> Logs out of this storyboard.
 *    HANDLED: the response is fetched for real and only the volatile fields are
 *    overwritten (below), so the CPU/GPU/OS readout stays genuinely this
 *    machine's while the shot stays byte-stable. If the fetch or the patch
 *    fails for any reason the real response is passed through untouched — a
 *    drifting shot is better than a broken one.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Pinned host metrics. Shape is `LoadDto`
 * (packages/backend/src/modules/system/dto/system.dto.ts). Disk sits at 38%,
 * deliberately under CORE_SERVER_DISK_USAGE_THRESHOLD (90), so the
 * CoreServerBanner stays down and the dashboard shot is not covered by an alert.
 */
const PINNED_SYSTEM_LOAD = {
  diskUsed: 178,
  diskSize: 465,
  percentUsed: 38,
  cpuLoad: 12.4,
  cpuCores: 8,
  memoryTotal: 32,
  memoryUsed: 13,
  percentUsedMemory: 41,
  hasVmWedge: false,
  runtimeKind: 'linux-native',
};

/**
 * Hazard 8. Only the fields that move between runs. Everything else in
 * `HardwareProfileResponse` (packages/frontend/src/modules/onboarding/helpers/
 * ai-setup-types.ts) is left exactly as the Hub reported it.
 */
const PINNED_PROFILE_VOLATILES = {
  ramAvailableMb: 9216,
  availableMemoryMb: 9216,
  availableDiskMb: 42_000,
  diskTotalMb: 76_800,
};

export default {
  baseURL: process.env.APP_URL ?? 'http://localhost:9091',

  // CI apps are dark-first. Pinned locale/timezone/clock keep captures stable.
  // The stage itself also runs with TZ=UTC (playwright.config.ts backendEnv).
  colorScheme: 'dark',
  locale: 'en-US',
  timezoneId: 'UTC',
  fixedTime: '2026-06-15T15:04:00Z',

  // No storageState — see hazard 7 above. The login happens inside the
  // `hub-home` shot's `before` block and persists for the rest of the run.

  async onContext(context, { viewport }) {
    // Warn loudly if an external asset fails — an unstyled capture looks like a
    // UI regression but is really a network failure. Montserrat is vendored by
    // the frontend build, so a googleapis hit here means something regressed.
    context.on('requestfailed', (req) => {
      if (/fonts\.(googleapis|gstatic)|cdn\./.test(req.url())) {
        console.warn(`  ! external asset failed: ${req.url()}`);
      }
    });

    // Hazard 1: pin the three-second host-metrics poll.
    await context.route('**/api/system/load', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PINNED_SYSTEM_LOAD),
      }),
    );

    // Hazard 8: pin only the volatile numbers in the hardware profile. Passing
    // the real response through on any failure keeps a bad patch from turning a
    // cosmetic drift into a failed shot.
    await context.route('**/api/inference/onboarding-profile', async (route) => {
      let response;
      let body;
      try {
        response = await route.fetch();
        body = await response.json();
        const ram = body?.hardware?.ram;
        if (ram) {
          ram.availableMb = PINNED_PROFILE_VOLATILES.ramAvailableMb;
        }
        const estimate = body?.resourceEstimate;
        if (estimate) {
          estimate.availableMemoryMb = PINNED_PROFILE_VOLATILES.availableMemoryMb;
          estimate.availableDiskMb = PINNED_PROFILE_VOLATILES.availableDiskMb;
          estimate.diskTotalMb = PINNED_PROFILE_VOLATILES.diskTotalMb;
        }
      } catch (err) {
        console.warn(`  ! could not pin the hardware profile (${err.message}) — passing it through`);
        body = undefined;
      }

      if (response && body !== undefined) await route.fulfill({ response, json: body });
      else if (response) await route.fulfill({ response });
      else await route.continue();
    });

    // Sentry is off on the E2E stage (ALLOW_ERROR_MONITORING=false), but a
    // developer capturing against their own Hub may have it on. Never let a
    // capture run phone home.
    await context.route(/ingest\.sentry\.io|sentry\.io\/api/, (route) => route.abort());

    if (process.env.VIDEO_DEBUG) {
      // biome-ignore lint/suspicious/noConsole: opt-in capture diagnostics
      console.log(`  · stage ready for ${viewport}`);
    }
  },
};
