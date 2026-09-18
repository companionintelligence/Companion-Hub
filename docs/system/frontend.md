# Frontend system — Companion Hub

> **Purpose:** React SPA — dashboard, app store, settings, hub startup gate, real-time logs.
> **Scope:** `packages/frontend/` — React Router 7, TanStack Query, hub-status, API client.
> **Key paths:** `packages/frontend/src/components/hub-status/`, `packages/frontend/src/modules/`, `packages/frontend/src/lib/`
> **Commands:** `cd packages/frontend && pnpm test`, `pnpm run local` (root, port 5004/5005)
> **Owner persona:** code-quality + maintainability
> **Last updated:** 2026-09-17 (dashboard scroll: new pages open at the top, back/forward restore)
> **Related:** docs/system/desktop.md, docs/DESKTOP-UI-ARCHITECTURE.md, docs/system/e2e.md

---

## Layout

```
packages/frontend/
  src/modules/          Page-level features (dashboard, app-store, settings, …)
  src/components/       Shared UI (hub-status, layouts, providers)
  src/lib/              API fetch, tauri probes, session, theme
  src/api-client/       Generated OpenAPI client + TanStack Query hooks
  routes/               React Router route definitions
```

## Dashboard scroll

Authenticated pages never scroll the window. `<main>` starts below the fixed header (a margin, not padding, so the header never covers its scrollbar), and its page wrapper is `flex-1 min-h-0`, so a page gets exactly the height below the header and banners. Keep the `min-h-0`: without it the wrapper grows to fit its content, every page's own scroller stops scrolling, and `<main>` scrolls everything instead, including the store sidebar.

Page scrollbars sit at the window's right edge, as in Portal, while content stays in a centred column. `<main>` spans the window and its `dashboard-column` utility (`src/styles/globals.css`) pads the content into the column that `container mx-auto px-2 sm:px-4` used to make. `--page-gutter` is the distance from the window edge to that column.

- A page that has its own scroller (the store pane, Home, Settings, the custom app pages, port expose) marks it `data-page-scroller="<name>"` and makes it `relative`. Without `relative`, absolutely positioned descendants such as Radix's hidden form inputs are placed against `<main>`, overflow it, and make it scroll as well.
- The same scroller takes `page-scroller-edge-<n>`, which stretches it over the gutter to the window edge and pads its content back into the column; `<n>` is its own end padding in spacing units. No element between it and `<main>` may clip overflow (`overflow-hidden` and the like): the scrollbar would be laid out at the window edge but not drawn. `src/components/layouts/dashboard/page-scrollers.test.ts` checks both.
- A page without its own scroller (app details under `/apps`, Resource Monitor) scrolls `<main>`.
- The store sidebar's category list scrolls on its own, with a visible scrollbar, when the window is too short for it.

`usePageScrollRestoration` (`src/lib/hooks/use-page-scroll-restoration.ts`) handles `<main>` and the marked scrollers of the page on screen. The page wrapper carries `data-page-key`, and the hook ignores a page that is still animating out. React Router's `<ScrollRestoration />` only tracks the window, and `<main>` and the store pane outlive their child routes.

- A PUSH or REPLACE that changes the path or query opens at the top.
- Back/forward returns each scroller to where that entry left it, retrying briefly while the page is still loading.
- A same-URL REPLACE (pages syncing their query) leaves the scroll alone, and the entry keeps its saved offsets under its new key.

Offsets are in memory, so a reload starts at the top.

Scrollbars use the tokens package's `::-webkit-scrollbar` styling: an `--accent` thumb on a `--muted` track, with no arrow buttons. `src/styles/globals.css` resets the tokens' `scrollbar-width` / `scrollbar-color` where the webkit pseudo-elements exist. Otherwise Chromium draws a thin native scrollbar with arrows, and WebKitGTK (the Linux desktop app) draws a GTK overlay scrollbar. `src/lib/scrollbar-hover.ts` marks the scroller whose scrollbar is under the pointer (`data-scrollbar-hover`), so the thumb shows faded while the pointer is anywhere on the track. The same rule sets a custom property on the element, because WebKit only repaints a custom scrollbar when the element's own style changes.

## Marketplace compatibility disclosure

The app-details information panel renders the optional `gpu_requirements` block
from the Marketplace manifest. It shows the accelerator type, whether the GPU
is required or optional, supported host platforms, and the declared minimum
VRAM before the user starts an install. This is a disclosure layer; lifecycle
preflight remains the enforcement point for host-device availability.

## Hub status gate

`packages/frontend/src/components/hub-status/hub-status.tsx` blocks the Tauri UI until the Hub API is healthy. **iOS/Android** (the thin-client app, including `ios:dev` / `android:dev`) skip this local-Hub gate and go to `/connect` until a remote Hub is chosen. **Mac / Linux / Windows** (browser or desktop Tauri) always set up a Hub the normal way — registration, login, onboarding. Do not send those clients to cloud connect.

Key behaviors agents must preserve:

- API probe (`/api/health/live`) is the UI gate — not Docker container state alone
- `sessionStorage` steady-state across reloads
- User-initiated reload uses `revalidate()` instead of `window.location.reload()`
- Optional sidecars (Tailscale, cloudflared) must not block `all_ready` or regress UI to startup screen
- The starting, "hasn't finished starting", stopped and couldn't-start screens are one `StartupScreen` card that must look and read the same as the desktop bootstrap page (`packages/desktop/bootstrap/`), because the app hands over from that page mid-startup. Change both together. `docs/system/desktop.md` describes the data both read from `get_startup_progress_command`.
- The Hub container can be newer or older than the desktop shell, so `readStartupProgress` treats fields an older shell leaves out as false, null, or (for Docker) available.
- Restart Hub needs `restart_hub_command` on the desktop IPC allowlist (`packages/desktop/src-tauri/permissions/allow-desktop-ipc.toml`). On an older shell without it, the screen starts the Hub instead.

Tests: `packages/frontend/src/components/hub-status/hub-status.test.tsx`

## API client

- Generated from backend OpenAPI: `pnpm run gen:api-client`
- Tauri release builds probe local ports via `packages/frontend/src/lib/tauri-hub-probe.ts`
- Session refresh: `packages/frontend/src/lib/hub-session-refresh.ts`
- Local Vite (`:5005`) must probe same-origin `/api/health/live` (the Vite proxy) before a leftover Docker Hub on `:5002`. Do **not** bind the API client to `:5004` or `:5002` — `/api` stays same-origin on `:5005` so the session cookie survives. Binding it was a 401 → full `/login` reload → "Connecting to local API...". HubStatus on `:5005` must ignore Docker compose status (that is the appliance stack). Featured (`GET /api/store/featured-bundle`) is served through that Vite proxy.
- Companion Account flows (`packages/frontend/src/lib/hub-auth-flow.ts` — do not mix):
  - **`mobile-cloud-connect`** — iOS/Android `/connect` only. Portal PKCE (`oidc.ts`) → Safari → `cihub://auth/callback` → `deep-link-oidc`. Not Hub `/portal/start`.
  - **`mobile-hub-sso`** — iOS/Android `/login` after a Hub is chosen. `{remoteHub}/api/auth/portal/start?desktop=1` in Safari → `cihub://auth?token=…` → `deep-link-auth`. Never localhost. Button + `openAuthInSystemBrowser` so WKWebView stays mounted.
  - **`desktop-hub-sso`** — Mac / Linux / Windows Tauri while the Hub is running. Same-origin (Vite `:5005` or packaged `:5002`) `/portal/start?desktop=1` in the system browser → `cihub-dev://` / `cihub://` → desktop-exchange on that Hub. Button + `openAuthInSystemBrowser`, never an `<a href>`: a same-origin anchor is left alone by the Providers link interceptor, so it navigates the app's own webview and unmounts `useDesktopPortalAuth` — the only code that exchanges the one-time token. Heartbeat `session-hint?desktop=1` so a Chrome loopback callback can hand off into Tauri.
  - **`browser-hub-sso`** — any browser on a Hub (including a phone browser). Same-origin `/portal/start` with no `desktop=1`; cookie session. On **loopback**, this is stolen into `desktop-hub-sso` while Tauri is announcing presence (10 min). Stop the desktop shell to test a real browser cookie session. Product origin is **`:5002`**; `:5005` is source-dev only — see `docs/system/desktop.md` ("Two stacks — do not mix").

## Styling

- Tailwind CSS 4 + Radix UI primitives
- UI style guide: `docs/UI-STYLE-GUIDE.md`
- Screen inventory: `docs/system/ui-screens.md`
- User flows: `docs/system/user-flows.md`
- iOS / Tauri mobile: `html.ci-mobile` sets `--safe-area-top` / `--safe-area-bottom` (WKWebView often reports `env(safe-area-inset-*)` as 0). The fixed Hub header and dashboard `pt` use `--header-offset`. Keep `viewport-fit=cover` in `index.html` and the root Layout. Do not pin `body` color/background with inline styles — theme tokens (`bg-background text-foreground`) must win in dark mode. Do not slide dashboard routes with Framer Motion (`translateX` + `opacity` paints a blank WKWebView). Radix Dropdown/Dialog/Select must be `modal={false}` on a phone so `react-remove-scroll` does not lock `body`. Phone navigation smoke: `packages/frontend/src/lib/ios-navigation.smoke.test.tsx` — add a case when you add a Hub overlay or a new authenticated route.

## Testing

- Vitest + Testing Library
- Mock Tauri via `window.__TAURI_INTERNALS__.invoke`
- Mock `@/lib/tauri-hub-probe` with `vi.hoisted` when intercepting module imports
- Phone navigation: `src/lib/ios-navigation.smoke.test.tsx` (WKWebView white-screen guards — not XCUITest)

## Cloud connect flow (iOS / Android)

**Terminology:** **Cloud connect flow** is the official name for the iOS/Android thin-client path that starts at **`/connect`**: sign into the Portal (Companion Account / PKCE), then pick one of your registered Hubs from the device list. It is **not** Hub registration, **not** desktop Tauri SSO, and **not** browser login on a Hub URL. Code gate: `usesCloudConnect()` in `mobile-connection.ts`; auth kind: `mobile-cloud-connect` in `hub-auth-flow.ts`. After a Hub is chosen, the app continues on **`/login`** (Hub SSO / password — separate flow).

The iOS/Android thin client signs into the Portal with PKCE and a `cihub://auth/callback` redirect.

- Desktop delivers the callback on `deep-link://new-url`. **iOS does not** — that event is desktop-only. The mobile Rust shell (`packages/mobile/src-tauri/src/lib.rs`) stashes the URL and emits `deep-link-oidc`.
- Safari → "Open with Companion Hub" often **cold-starts** the app. PKCE verifier/state are persisted in `localStorage` (`cihub.oidc.pending`) and `resumePendingOidcLogin()` finishes the exchange on `/connect` mount. The callback URL is peeked (not taken) in Rust and also mirrored to `cihub.oidc.callback` so a `/connect` reload cannot drop it. A warm return must not reload Vite — that killed the in-flight waiter.
- A WKWebView whose document is `cihub://…` or the mobile-dev `tauri://localhost` proxy is a blank black screen on iOS 26. `devUrl` is `http://lvh.me:5005` so the first load skips that proxy. Rust then `navigate()`s to `http://localhost:5005/connect` (ATS only auto-allows cleartext HTTP to `localhost`). Do not pass `--host 127.0.0.1`. Do not call `window.url()` / `navigate()` from overlapping background threads — wry 0.55 unwraps a nil `WKWebView.URL` and the Simulator shows the Apple "Reopen / Report" crash.
- ios:dev IPC: `capabilities/default.json` must list `remote.urls` for `http://localhost:*`. Without that, `event.listen` / `opener` are denied on the Vite origin and Sign in spins forever.
- iOS 26: Info.plist must use Tao's scene (`TaoScene` / `TaoSceneDelegate`, `UIApplicationSupportsMultipleScenes: true`). A "Default Configuration" with no delegate shows a black scene while the webview runs off-screen.
- Do not leave a debug HUD or a second "Connect to your Hub" splash on the phone. Bootstrap sends the user to `/connect` (cloud sign-in) or `/login` (chosen Hub). Switch Hub lives on `/login` and `MobileLoadError`.
- Cloud connect (`/connect`) is **iOS/Android app only**. The single gate is `usesCloudConnect()` in `packages/frontend/src/lib/mobile-connection.ts` (`VITE_HUB_RUNTIME=mobile`, `lvh.me`, or Tauri + iOS/Android). Mac / Linux / Windows — browser or desktop Tauri — never take that path. A leftover `cihub.isTauriMobile` session flag from sharing Vite `:5005` with ios:dev must not send desktop there (Linux/Windows UA and the desktop OS plugin both clear it). A phone *browser* on a Hub URL still uses normal `/login`.
- After OIDC, list Hubs with `GET /api/users/me/apps?slug=hub` (Bearer access token). `GET /api/devices` needs a better-auth session and returns 401 for the OIDC token. Email/password still uses `/api/devices`.
- Cloud-connect Companion URL is always `https://hub.ci.computer` (`DEFAULT_PORTAL_URL` in `mobile-connect/portal-client.ts`). That is independent of the Hub appliance's `CI_CLOUD_URL` / `CI_HUB_ENVIRONMENT`. Advanced can set a custom Companion URL. A previously persisted `hub.companionintelligence.com` is ignored so old installs migrate to production.
- Authorization codes are single-use. Safari + `/connect` resume both try the same code — exchange is memoized per code so the loser does not toast "invalid code".
- After a Hub is chosen, go to `/login` (not `/`). Root must not wait on the remote Hub's registration API on any mobile route.
- `I18nProvider` must not fetch `/api/i18n` on a phone — that `window.fetch` to the remote Hub never settles and leaves the exact "Loading…" screen. Use bundled `en`.
- Hub `/login` Portal SSO on iOS/Android uses the chosen Hub URL (not `localhost:5002`) with `desktop=1`, opened in Safari via `openAuthInSystemBrowser`, so the phone returns via `cihub://auth?token=…` instead of navigating the WKWebView away from `/login`.
- The SSO button email is the **Portal user** from the OIDC `id_token` (or email/password), stored in `ci-hub.portalAccountEmail`. On a phone, that wins over the Hub operator (`hub_operator` is often `support@…` on a shared appliance).
- Hung Hub calls must not spin forever. I18n never gates on "Loading…". Root loader, `/home` session/app-context, and a 6s DOM watchdog all end in Retry + Switch Hub. The HTML boot strip also grows Reload / Connect if React never paints. Do not send a failed app-context load into onboarding.

Tests: `packages/frontend/src/modules/mobile-connect/oidc.test.ts`, `connect-page.test.tsx`

## Onboarding inference setup

`AiSetupStep` owns Step 3 of the FTUE: one “Set up inference” panel contains the backend choice,
the selected backend's readiness check, and the Ollama embeddings check when a host-served backend
is selected. On Apple Silicon macOS it presents a Speculative inference group with `mlx-dspark`
first, MTPLX nested beneath it, and Lucebox available as the provider-neutral option. When the
operator confirms “Install & Finish”, `InstallStep` asks the desktop shell to install and start the
selected speculative runner (`mlx-dspark` or MTPLX) alongside Ollama (embeddings); it persists the
actual MTPLX endpoint when the runner has to move off port 8000. A plain browser build does not
have a native process boundary, so it retains the manual setup and re-check flow.

Runner selection is exact rather than a fleet-wide install: mlx-dspark, MTPLX, vLLM, and Lucebox
each pair only with Ollama; Ollama and operator-managed Lemonade request only Ollama. Unknown future
backend ids retain the complete native fallback set. This keeps FTUE from downloading unrelated
engines and lets desktop reconcile the two mutually exclusive macOS login services.

`RecommendationsStep` uses the Alternatives chart treatment for its optional app discovery section:
it shows a curated 20-app shortlist across ten categories, grouped in compact paired comparison rows. Category
counts, repeated column labels, and the agent-selection summary are intentionally omitted so this
optional section stays focused and compact. Portal or synced catalog metadata supplies the app icon
and display name, including tiny Portal/fallback marks for the private apps being replaced; canonical
CI Marketplace URNs keep every curated row selectable even before a local catalog refresh completes.
The page owns the only vertical scroll on the chart, and each compact row exposes a keyboard-accessible
checkbox with a category-colored fallback icon on mobile and desktop. The FTUE shell centers the official
CI-Server e-brain mark in a centered squircle above its title, with the title block set down from the
top edge so the page header remains legible at phone widths.
Step 5 keeps Companion Memory as one keyboard-accessible checkbox on its option card; the step panel
itself is informational and does not add a second selection layer.

## Semantic status colors

Use the design-system `success` and `warning` tokens for status communication across the frontend:
`border-success/30 bg-success/10 text-success` and `border-warning/30 bg-warning/10 text-warning`.
Use `text-success-foreground` / `text-warning-foreground` on solid controls. Do not add component-local
yellow, amber, green, or emerald ramps or dark-mode shade overrides for these roles; raw hues remain
appropriate only for non-status meaning such as model score tiers, recommendation categories, ratings,
and user-selectable theme colors.

## Custom domains

When CI-Cloud has wired a customer hostname to an app, `app.customDomain` carries it and that is the
address the UI shows — the access-points card links and QR-codes it, and `resolveAppAvailability`
probes it. It always resolves on 443: Cloudflare terminates the customer hostname there and nowhere
else, so the Hub's local `sslPort` must never be appended to it.

Binding raises `pendingRestart` rather than recreating the container, so there is a deliberate window
where the row names the custom domain and the running container does not. `public-web/diagnostics`
reports that window as `action: 'ok'` with `envMismatch: true` — **key UI off `action`, not
`envMismatch`**, or a healthy app awaiting its restart is shown as broken.

Genuine drift raises a banner in the app config dialog carrying its own **Repair routing** action
(`repairPublicWebRouting` in `lib/cloudflare-api.ts` → `POST /api/public-web/repair`). It has to be a
separate action: routing drift leaves the form clean, so the dialog's Update button — gated on
`isDirty` — cannot be the remedy. Two things that path depends on:

- The generated client **resolves** on a non-2xx unless `throwOnError` is passed, so an error from
  the interceptor arrives as `result.error`, not as a rejection. Rethrow it or a denied grant loses
  its `APP_ACTION_GRANT_DENIED` message.
- An empty `results` array means the Hub found nothing drifted, which is not a repair — clear the
  banner, but do not claim one.

⚠ `SSEService.emit('app', data, appUrn)` publishes to `app:<urn>`, which nothing subscribes to: the
client opens `/api/sse/app` only. Omit the third argument.

## Agent notes

- Biome forbids non-null assertions (`!`) — use explicit types
- Run scoped tests: `pnpm test -- src/path/to/file.test.tsx`
- Always run `pnpm run local` or `local:desktop` for UI source changes. For appliance-parity SSO (browser or Tauri against `hub.companionintelligence.com`), use `pnpm run dev` / `dev:desktop` on `:5002` — never both stacks at once.
- App-detail "Open data folder" is desktop Tauri only. Web / phone copy the Hub host path (`canOpenFolderInFileExplorer` in `lib/helpers/open-folder.ts`).
