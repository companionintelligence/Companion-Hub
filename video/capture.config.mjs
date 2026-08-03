/**
 * Capture stage for Companion Hub.
 *
 * `ci-video capture` drives the REAL app through this config. The stage is the
 * repo's own Playwright E2E stage — mock-portal + backend + frontend PREVIEW
 * build — exactly the three servers in `playwright.config.ts` -> `webServer[]`.
 * See video/README.md and .github/workflows/video.yml for the boot command.
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
 * 4. RESOURCE MONITOR SAMPLE CLOCK — modules/system/pages/resource-monitor-page.tsx
 *    renders `RESOURCE_MONITOR_LAST_SAMPLED` ("Last sampled {{time}}") from the
 *    SERVER's timestamp, so `context.clock.install` does not freeze it.
 *    HANDLED: masked via `text=Last sampled` on that shot. The per-app CPU and
 *    memory columns are volatile too, but on a fresh stage no apps are
 *    installed, so the table is empty and the totals read 0.0% / 0 B.
 *
 * 5. DEVICE ID — the device-registration page prints the Hub's device id.
 *    HANDLED: masked via `text=Device ID`. On the E2E stage it is pinned to
 *    `test-device-e2e` anyway (playwright.config.ts backendEnv.DEVICE_ID).
 *
 * 6. STORE CATALOG DEPTH — NOT HANDLED, and it is a stage prerequisite, not a
 *    code problem. `e2e/start-backend.sh` symlinks `$CI_MARKETPLACE_DIR/apps`
 *    (default `../CI-Marketplace`) into `$CI_HUB_DATA_DIR/repos/ci-marketplace/apps`;
 *    without that checkout the script prints "app store will be empty" and the
 *    store + app-details shots film an empty grid and then FAIL on their
 *    `a[href^='/store/']` waitFor. The mock portal's own `GET /api/store`
 *    (e2e/mock-portal/scenarios.ts) returns only two sample apps and is NOT the
 *    catalog these pages render. Check out CI-Marketplace beside this repo
 *    before capturing.
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
  runtimeKind: "linux-native",
};

export default {
  baseURL: process.env.APP_URL ?? "http://localhost:9091",

  // CI apps are dark-first. Pinned locale/timezone/clock keep captures stable.
  // The stage itself also runs with TZ=UTC (playwright.config.ts backendEnv).
  colorScheme: "dark",
  locale: "en-US",
  timezoneId: "UTC",
  fixedTime: "2026-06-15T15:04:00Z",

  // No storageState — see hazard 7 above. The login happens inside the
  // `hub-home` shot's `before` block and persists for the rest of the run.

  async onContext(context, { viewport }) {
    // Warn loudly if an external asset fails — an unstyled capture looks like a
    // UI regression but is really a network failure. Montserrat is vendored by
    // the frontend build, so a googleapis hit here means something regressed.
    context.on("requestfailed", (req) => {
      if (/fonts\.(googleapis|gstatic)|cdn\./.test(req.url())) {
        console.warn(`  ! external asset failed: ${req.url()}`);
      }
    });

    // Hazard 1: pin the three-second host-metrics poll.
    await context.route("**/api/system/load", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PINNED_SYSTEM_LOAD),
      }),
    );

    // Sentry is off on the E2E stage (ALLOW_ERROR_MONITORING=false), but a
    // developer capturing against their own Hub may have it on. Never let a
    // capture run phone home.
    await context.route(/ingest\.sentry\.io|sentry\.io\/api/, (route) => route.abort());

    if (process.env.VIDEO_DEBUG) console.log(`  · stage ready for ${viewport}`);
  },
};
