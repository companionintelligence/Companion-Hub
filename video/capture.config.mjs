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
 * 6. STORE CATALOG DEPTH — HANDLED, from recorded production responses. There
 *    are TWO catalogs behind /store, and they come from different places:
 *
 *    a) The DEFAULT view. app-store-page.tsx sets DEFAULT_STORE_CATEGORY =
 *       'featured', and FeaturedStoreView sources all four of its sections from
 *       `portalStoreListingsQueryOptions` -> GET /api/store/listings
 *       (app.controller.ts) -> portal-client.fetchStoreListings -> the PORTAL's
 *       `/store`. On this stage CI_CLOUD_URL points at the mock portal, whose
 *       `GET /api/store` handler returns exactly two apps (ci-openclaw, n8n) and
 *       IGNORES the `tags` / `sort` query — all four sections would render the
 *       same two cards, and `GET /api/store/alternatives` a single row
 *       (Notion -> AppFlowy). Filming that under captions about breadth and
 *       choice would be a false claim.
 *
 *       HANDLED: `/api/store/listings` and `/api/store/alternatives` are
 *       fulfilled below from `fixtures/portal-store-listings.json` and
 *       `fixtures/portal-store-alternatives.json`. Those files are not
 *       invented — they are RECORDINGS of the live production Portal
 *       (`https://hub.ci.computer/api/store…`, a public unauthenticated
 *       endpoint), taken with the four exact queries FeaturedStoreView issues,
 *       then projected onto the handful of fields `mapPortalStoreAppToHub`
 *       actually reads. Re-record with `node fixtures/record-portal-store.mjs`.
 *       Recording beats proxying live: the catalog moves, and a live fetch would
 *       churn `hub-store` on every capture for reasons that are not UI changes.
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
 *    visitor straight to /home. The stage must run `video/stage/seed.mts` first;
 *    it creates the `owner@acme.com` / `password` operator the storyboard's
 *    `before` blocks type in. The operator's address is ON SCREEN in two shots
 *    (the login hint, and Settings -> Security's change-username placeholder),
 *    which is why the stage does not reuse e2e's `test@test.com`.
 *
 *    The two FTUE shots are the exception: `onboarding-wizard` and
 *    `device-registration` are captured in their own later passes with their own
 *    fresh BrowserContext (video/README.md § "Three capture passes"), so
 *    `onboarding-wizard` carries its own login in `before`.
 *
 * 8. ALTERNATIVES FAVICONS — the alternatives table renders each vendor pill's
 *    icon from `https://www.google.com/s2/favicons?...`, straight out of the
 *    Portal payload, with no onError fallback. Those are real outbound requests
 *    the real product makes; left alone, so the shot shows what a user sees. If
 *    the capture runs offline they render as broken-image glyphs — check the
 *    frame, do not ship it.
 *
 * 9. APP STATUS IS NOT A RUNNING CONTAINER — NOT HANDLED, and it is why
 *    `install-and-run` has no shot. video/stage/seed.mts writes installed-app
 *    rows straight into the DB, which is enough for `hub-home`'s tiles (they
 *    render name + logo off the marketplace catalog). It is NOT enough for the
 *    status pill: getAppStatusPresentation
 *    (frontend/src/modules/app/components/app-status/app-status.tsx) downgrades a
 *    `running` app to an amber, animated "Initializing" whenever runtime health
 *    reports zero containers. So `/apps/<store>/<app>` films an amber pill under
 *    a caption promising a green badge.
 *
 *    A genuine install is not available on this stage either: installApp ->
 *    ReposHelpers.downloadAppFiles pulls the app bundle from the PORTAL
 *    (`/api/store/:id/install`, device-authenticated), which the mock portal does
 *    not serve — it fails with "Failed to fetch app files: 404". Re-add the shot
 *    alongside a pass that has a real Portal install bundle and a real container
 *    running, not by seeding a greener status.
 *
 * 10. EXPOSE-A-PORT DNS CHECK — the Expose a port form debounces a live
 *    subdomain-availability call (`/api/cloudflare/check-dns-availability`,
 *    frontend/src/lib/cloudflare-api.ts) as soon as the Public Web mode is
 *    selected. There is no Cloudflare account behind the stage, so it answered
 *    404 and the first `port-expose` frame came back with a red-outlined
 *    subdomain field and a "Not found" error toast sitting over the form.
 *    HANDLED: fulfilled with `{ available: true }` below — the ordinary answer
 *    for an unused subdomain, and the state the caption is describing.
 *
 * 11. HARDWARE PROFILE — the `ai-hardware` shot films the AI tab's hardware card,
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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const readFixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

/**
 * Hazard 6a. Recorded production Portal catalog. `queries` maps the exact
 * query strings FeaturedStoreView issues to the id order the Portal answered
 * with; `apps` holds the four fields `mapPortalStoreAppToHub` reads.
 * Re-record with `node fixtures/record-portal-store.mjs`.
 */
const PORTAL_STORE = readFixture('portal-store-listings.json');
const PORTAL_ALTERNATIVES = readFixture('portal-store-alternatives.json');

/**
 * Rebuild the key the recording is indexed by. The generated SDK always sends
 * all four params, empty-string for the ones that are unset
 * (`portal-store.ts` -> `fetchPortalStoreListings`), so blanks are dropped
 * before lookup. Key order matches the Portal's own param order.
 */
function portalStoreQueryKey(url) {
  const p = url.searchParams;
  const parts = [];
  for (const k of ['category', 'tags', 'sort', 'q']) {
    const v = p.get(k);
    if (v) parts.push(`${k}=${v}`);
  }
  return parts.join('&');
}

/** Project the recording back into the Portal's `GET /store` array shape. */
function portalStoreListings(key) {
  const ids = PORTAL_STORE.queries[key] ?? PORTAL_STORE.queries[''];
  return ids.map((id) => {
    const app = PORTAL_STORE.apps[id];
    // `icon` is deliberately omitted: AppCard then falls back to the Hub's own
    // /api/marketplace/apps/<urn>/image, which serves the SAME logo off the
    // CI-Marketplace checkout instead of 492 round-trips to hub.ci.computer.
    return { id, name: app.name, short_desc: app.short_desc, categories: app.categories };
  });
}

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
 * Hazard 11. Only the fields that move between runs. Everything else in
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

    // Hazard 6a: serve the recorded production catalog in place of the mock
    // portal's two-app stub. Query-aware, so the featured view's four sections
    // stay four genuinely different shelves.
    await context.route('**/api/store/listings*', (route) => {
      const key = portalStoreQueryKey(new URL(route.request().url()));
      if (!(key in PORTAL_STORE.queries)) {
        console.warn(`  ! no recorded portal catalog for "${key}" — falling back to the unfiltered one`);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(portalStoreListings(key)),
      });
    });

    // Hazard 6a: the alternatives payload is a static file in the Portal repo
    // (domains/store/handlers/alternatives.json), so this recording is byte-for-byte
    // what production answers with.
    await context.route('**/api/store/alternatives', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PORTAL_ALTERNATIVES),
      }),
    );

    // Hazard 10: answer the Expose-a-port form's live subdomain check. On a real
    // Hub this asks Cloudflare whether `<app>-<org>.<domain>` is free; on the
    // stage there is no Cloudflare account behind it, so it answered "Not found"
    // and the shot came back with a red field and an error toast over the form.
    // `{ available: true }` is the ordinary answer for an unused subdomain — the
    // state the caption describes.
    await context.route('**/api/cloudflare/check-dns-availability*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) }),
    );

    // Hazard 11: pin only the volatile numbers in the hardware profile. Passing
    // the real response through on any failure keeps a bad patch from turning a
    // cosmetic drift into a failed shot.
    await context.route('**/api/inference/onboarding-profile*', async (route) => {
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
