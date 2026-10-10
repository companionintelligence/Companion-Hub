# Frontend system — Companion Hub

> **Purpose:** React SPA — dashboard, app store, settings, hub startup gate, real-time logs.
> **Scope:** `packages/frontend/` — React Router 7, TanStack Query, hub-status, API client.
> **Key paths:** `packages/frontend/src/components/hub-status/`, `packages/frontend/src/modules/`, `packages/frontend/src/lib/`
> **Commands:** `cd packages/frontend && pnpm test`, `pnpm run local` (root, port 5004/5005)
> **Owner persona:** code-quality + maintainability
> **Last updated:** 2026-10-04 (Hub Pool setup guide)
> **Related:** docs/system/desktop.md, docs/DESKTOP-UI-ARCHITECTURE.md, docs/system/e2e.md

---

## Layout

```
packages/frontend/
  src/modules/          Page-level features (dashboard, app-store, settings, …)
  src/components/       Shared UI (hub-status, layouts, providers)
  src/lib/              API fetch, tauri probes, session, theme
  src/api-client/       Generated OpenAPI client + TanStack Query hooks (generator-owned)
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
- `packages/frontend/src/api-client/` is **generator-owned**: `gen:api-client` wipes the directory and rewrites it from `packages/backend/src/swagger.json` (see `openapi-ts.config.ts`). Never hand-write a file there. A committed one survives only until the next regeneration, then shows up as an unexplained deletion in someone's diff, and restoring it by reflex re-arms the trap. Hand-written wrappers over the generated SDK belong in `src/lib/api-routes/` — for example `named-status-routes.ts`, which names the generator's numbered `getStatusN` operations.
- Tauri release builds probe local ports via `packages/frontend/src/lib/tauri-hub-probe.ts`
- Session refresh: `packages/frontend/src/lib/hub-session-refresh.ts`
- Local Vite (`:5005`) must probe same-origin `/api/health/live` (the Vite proxy) before a leftover Docker Hub on `:5002`. Do **not** bind the API client to `:5004` or `:5002` — `/api` stays same-origin on `:5005` so the session cookie survives. Binding it was a 401 → full `/login` reload → "Connecting to local API...". HubStatus on `:5005` must ignore Docker compose status (that is the appliance stack). Featured (`GET /api/store/featured-bundle`) is served through that Vite proxy.
- Companion Account flows (`packages/frontend/src/lib/hub-auth-flow.ts` — do not mix):
  - **`mobile-cloud-connect`** — iOS/Android `/connect` only. Portal PKCE (`oidc.ts`) → `openAuthSession` (iOS in-app `ASWebAuthenticationSession` sheet, Android system browser) → `cihub://auth/callback` → `deep-link-oidc`. Not Hub `/portal/start`.
  - **`mobile-hub-sso`** — iOS/Android `/login` after a Hub is chosen. `{remoteHub}/api/auth/portal/start?desktop=1` via `openAuthSession` → `cihub://auth?token=…` → `deep-link-auth`. Never localhost. Button + `openAuthSession` so WKWebView stays mounted and iOS never jumps out to Safari.
  - **`desktop-hub-sso`** — Mac / Linux / Windows Tauri while the Hub is running. Same-origin (Vite `:5005` or packaged `:5002`) `/portal/start?desktop=1` in the system browser → `cihub-dev://` / `cihub://` → desktop-exchange on that Hub. Button + `openAuthInSystemBrowser`, never an `<a href>`: a same-origin anchor is left alone by the Providers link interceptor, so it navigates the app's own webview and unmounts `useDesktopPortalAuth` — the only code that exchanges the one-time token. Heartbeat `session-hint?desktop=1` so a Chrome loopback callback can hand off into Tauri. The Hub takes that flag only from a request sent straight to its loopback address, and only while the window is signed out. `session-hint` names an account only to a signed-in caller, so the heartbeat keeps the window's own account in `ci-hub.portalAccountEmail` for the sign-in screen.
  - **`browser-hub-sso`** — any browser on a Hub (including a phone browser). Same-origin `/portal/start` with no `desktop=1`; cookie session. On **loopback**, this is handed to `desktop-hub-sso` while the desktop app is open and signed out (10 min). A sign-in on any other address stays in the browser. Sign the desktop app in, or stop it, to test a real browser cookie session on loopback. Product origin is **`:5002`**; `:5005` is source-dev only — see `docs/system/desktop.md` ("Two stacks — do not mix").

## Desktop app release

Settings → System → **Desktop app** offers the newest desktop installer for the computer you are on. The download servers (`dl.ci.computer` for a `production` build, `dl-dev.ci.computer` for every other build) send no CORS headers, so a browser cannot read them. A plain browser asks its Hub instead: `GET /api/system/update/desktop-release` with the page's build environment, platform, and architecture. The Hub reads only those two servers and reuses an answer for five minutes. A production Hub (`CI_HUB_ENVIRONMENT=production`) reads only `dl.ci.computer`, whatever the page asks, so it never offers a dev build.

- The architecture comes from Chromium's client hints (`getHighEntropyValues(['architecture'])`) where the browser has them, because every Mac browser's user agent says "Intel Mac". Safari and Firefox have none, so a Mac gets the Apple silicon installer there.
- A phone or tablet browser gets no installer and does not ask the Hub. `isMobileUserAgent()` catches iPhone, iPod, Android, and an iPad, including an iPad that reports itself as a Mac (it has touch points). Without that check, an iPhone's user agent passes for macOS and an Android one for Linux.
- The desktop app asks the Rust shell (`check_desktop_update_command`). When that fails it still reads the servers directly, and so does the phone app, which always lands there. Routing that fallback through the Hub would make the phone app offer desktop installers.
- `desktop-release.ts` in `@ci-hub/common/types` holds the server choice, the installer choice, and the URL trust check for both the Hub and the page, so the page accepts the installer the Hub returns.
- The install steps under the button never say to remove the app first. Removing the Linux package runs its cleanup (deb `postrm` on `remove`/`purge`, rpm `postun` at `0`), which deletes the Hub's database, every app with its data, and the Hub's folder. The steps install over it: `sudo apt install "./<file>"`, `sudo rpm -U "./<file>"`, or `chmod +x "./<file>"` for an AppImage. `<file>` is the download URL's last segment, decoded (`Companion Hub_0.2.78_amd64.deb`, with a space), and the step shows no command when the name has anything but letters, digits, spaces, `.`, `_`, `+` and `-`.
- In the desktop window, an available update installs in one click: `installDesktopUpdate()` in `update-service.ts` calls the app's `perform_desktop_update_command` and reports `get_update_progress_command`. The updater stops the Hub during the update (older releases before they install, current ones once the update is installed), so `HubStatus` keeps the page while `isDesktopUpdateRunning()`, and a failed call starts the Hub again when its API doesn't answer. Then the card offers the download and the manual steps, unless the app had reported `done` or `relaunch`: the update is installed and only the restart failed, so the card says to quit and reopen the app. See [`DESKTOP-AUTO-UPDATE.md`](../DESKTOP-AUTO-UPDATE.md).
- The card never says the desktop app isn't running. The Hub can't reach the listener of any desktop app up to 0.2.77, so an unreachable listener says nothing about the app. A browser gets where to update instead: Companion Hub on the computer that runs the Hub, or `companion-hub update` there.

## Styling

- Tailwind CSS 4 + Radix UI primitives
- UI style guide: `docs/UI_STYLE_GUIDE.md`
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
- Hub `/login` Portal SSO on iOS/Android uses the chosen Hub URL (not `localhost:5002`) with `desktop=1`, opened via `openAuthSession` (iOS in-app Safari sheet, Android system browser), so the phone returns via `cihub://auth?token=…` instead of navigating the WKWebView away from `/login`.
- The SSO button email is the **Portal user** from the OIDC `id_token` (or email/password), stored in `ci-hub.portalAccountEmail`. On a phone, that wins over the Hub operator (`hub_operator` is often `support@…` on a shared appliance).
- Hung Hub calls must not spin forever. I18n never gates on "Loading…". Root loader, `/home` session/app-context, and a 6s DOM watchdog all end in Retry + Switch Hub. The HTML boot strip also grows Reload / Connect if React never paints. Do not send a failed app-context load into onboarding.

Tests: `packages/frontend/src/modules/mobile-connect/oidc.test.ts`, `connect-page.test.tsx`

## Onboarding inference setup

`AiSetupStep` owns Step 3 of the FTUE: one “Set up inference” panel contains the backend choice,
the selected backend's readiness check, and the Ollama embeddings check when a host-served backend
is selected. Apple Silicon offers Ollama and oMLX. NVIDIA offers Ollama and vLLM. AMD or NPU offers Ollama and Lemonade. Manual mode is a decode endpoint and an encode endpoint. When the
operator confirms “Install & Finish”, `InstallStep` asks the desktop shell to install the chosen runner. oMLX is Homebrew. vLLM pairs with Ollama for embeddings. A plain browser build does not
have a native process boundary, so it retains the manual setup and re-check flow.

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

## Hub Pool setup guide

`PoolSetupWizard` walks an operator through pairing Hubs. It is a Radix dialog, full screen on a phone, with four steps (`ready`, `find`, `connect`, `approve`) that the stepper labels **Check**, **Find**, **Connect**, and **Approve**. It adds no backend route: it calls the endpoints that **Settings → Network → Hub Pool** already uses, through the generated client. The one backend change is that `GET peers/discoverable` rows gained optional `os` and `online` fields, which the Hub cards show. The operator-facing description is [`hub-pool.md` → Set up a pool](../hub-pool.md#set-up-a-pool).

The code is in `src/modules/settings/components/pool-setup-wizard/`. `pool-setup-model.ts` holds the pure logic (readiness checks, first-step choice, failure classes, per-peer progress, the Home invitation rule), and most of the unit tests target it. `src/modules/settings/helpers/hub-pool-shared.ts` holds the pool types and helpers (`peerLabel`, `isUnverifiedCandidate`, `mergePoolModels`) that the panel and the wizard share, so neither imports the other. `useTailscaleBrowserAuth` (`src/lib/hooks/`) is the **Connect Tailscale** action, shared with the Private VPN card so the two cannot disagree.

Two pieces of presentation are shared across steps. `pool-hub-card.tsx` renders a Hub as spans only (`PoolHubSummary`), so the same body sits inside a selectable label on **Find** and inside a plain card (`PoolHubCard`) on **Connect** and **Approve**. Every chip on it shows only what is known: before pairing, the OS and **Online** or **Offline** from the tailnet; after the first health read, the Hub's own hardware tier, running engines, and model count. An unknown tier or OS is dropped or shown as **Other**, never guessed. `pool-setup-footer.tsx` is the sticky action bar, with the primary action last in reading order and first on a phone, at a 44 px tap height. `PoolSetupStepper` is a list, not tabs: a step is entered only through that step's own buttons, so nobody can jump to **Connect** with nothing chosen. On a phone it collapses to "Step N of 4 · Label" over a progress bar, and the list stays in the page, visually hidden, for assistive technology. Focus moves to the new step's heading (`data-step-heading`) when the step changes.

**Entry points.** Three hosts open the guide, and each owns its own `useDisclosure()`:

- **Home.** `PoolSetupCard` (`modules/dashboard/components/pool-setup-card.tsx`) shows one of two cards, decided by `poolInvitation()`. The invite card needs a registered Hub, Tailscale connected, pooling on, `peerCounts.total === 0`, and no dismissal. The review card shows for any inbound pending request while pooling is on, ignores dismissal, and is for the receiving Hub, where nothing else says a request arrived. Its button reads **Review request**, or **Review requests** for more than one. Do not add `data-page-scroller` to either card: `page-scrollers.test.ts` scans every `.tsx`.
- **Settings.** `PoolSetupCallout` (**Set up Hub Pool**) sits at the top of the Hub Pool panel while no peer is `connected` or `unreachable`, and not when `HUB_POOL_USER_DISABLED` locks pooling off. Once a peer is paired the callout goes away and **Add Hubs** (`pool-setup-add-hubs`) replaces it. **Add Hubs** passes `startAt="find"`, which skips the resume-on-`approve` rule below so the guide opens at the scan, or at **Check** when the Hub is not ready. The **Discoverable devices** block has **Rescan** (`hub-pool-rescan-btn`), which refreshes the panel's own list by hand, and, once a peer is paired, **Add another Hub** (`hub-pool-add-hub-btn`). That second button does not touch `startAt`, so on a fresh panel it opens the guide on `approve`.
- **Onboarding.** `PoolSetupOnboardingSection` sits after `<AiSetupStep>`, gated on its own live Tailscale query. It never calls `onConfigChange`, so it cannot change `canFinish`.

Each host renders `LazyPoolSetupWizard` **outside** the element it hides. The Home card disappears the moment the first request makes `peerCounts.total` 1, and the onboarding section disappears if Tailscale drops. A wizard rendered inside either would unmount mid-flow. The lazy wrapper also keeps the wizard out of the Home chunk and out of suites that mock the panel's modules with a closed list.

**Invariants:**

- **The Hub holds the state.** Only transient UI state (selection, the typed PIN, this session's send results) lives in React. On open, the guide works out its step from `GET /status`: any peer row means `approve`, so it never replays `connect`. The exception is `startAt="find"`, which the user asked for by pressing **Add Hubs**. Step 1 is skipped when every readiness check is ready (`chooseInitialStep`). A reload or close loses nothing that matters.
- **Nothing is pre-selected.** A pairing request is an introduction made on the user's behalf to another machine, and a tailnet can hold Hubs that belong to someone else or that the user keeps apart, so "send to everything found" must be a decision, never a default. `FindStep` keeps the chosen set (`chosen`). A rescan keeps choices that are still on the list, and a newly found Hub arrives unchosen. The main button reads **Choose Hubs** until something is chosen, then **Send N request(s)**. Do not add an initial selection. The typed PIN is remembered with the Hub it was typed for and applies only while exactly one Hub is chosen, because a refused PIN counts against that Hub's attempt limit.
- **A request is never sent twice.** The server answers 409 for any name that already has a row. Discovery excludes every name with a row. The guide re-reads `/status` right before it sends and skips any name that now has a row. An in-flight set and a disabled send button stop a double click. A retry passes the same checks and never reuses the PIN, which is single use. Closing the guide does not cancel or replay a send in flight.
- **Discovery runs on demand.** `GET peers/discoverable` probes every unpaired tailnet device, so the guide calls it once when `find` opens and again on **Rescan**, as a mutation (`useDiscoveryScan`) under no shared query key. Nothing that invalidates queries, resumes a tab, or polls reaches it. The panel's own discoverable query has no `refetchInterval` for the same reason: it refetches after a pool mutation and on the panel's **Rescan** (`refetch({ cancelRefetch: false })`, so a second press does not restart a running scan). The Home card reads `/status` (one query, no probing), never discovery.
- **Two polls never stop while their page is mounted.** `PoolSetupCard` reads `/status` every `POLLING.POOL_NUDGE_MS` (30 s) on Home outside demo mode, which is why the review card can lag a request by up to 30 s. `PoolSetupOnboardingSection` reads the Tailscale status every `POLLING.REGISTRATION_MS` (3 s) while first-run setup is open. Neither probes the tailnet.
- **Polling stops.** On `approve`, the guide polls `/status` every `POLLING.POOL_SETUP_WAIT_MS` (3 s) only while a request is incoming or waiting, or a connected Hub has not reported its models. It stops when that clears, after `PAIRING_WAIT_MAX_MS` (10 minutes), on close, and while the tab is hidden. **Check again** re-arms it. The readiness step polls Tailscale every `POLLING.POOL_SETUP_READINESS_MS` (5 s) only while it is on screen.
- **The "request is gone" notice compares against a fresh status.** It fires only for a name this session sent, that is missing from a status fetched after the send settled, and that was not cancelled or unpaired here.
- **Three row states need the operator, and each gets an Unpair button.** `peerProgress()` returns `half_paired` (this Hub approved, but its probes of the requester get 403, which means the approval never arrived; judged after two failed probes of a never-read row, or at once once `unreachable`), `needs_repair` (`identity_changed`), and `needs_credentials` (`unauthorized`). The backend backs off on the last two and none of the three recovers by waiting, so telling the user to wait would be wrong. Plain `unreachable` heals by itself and gets no button. Unpair is `removePeer`, which also asks the other Hub to drop its row with the token this Hub stored, so a request still waiting there is cleared when that Hub can be reached.
- **Pairing errors are opaque.** The backend throws a plain `Error` for an unreachable peer, a declined request, a wrong PIN, a full pending queue, and a self-pair, and `MainExceptionFilter` turns every one of them into a 500 with no message. `classifyPairFailure()` therefore cannot name the cause of a 500, and the copy lists the causes instead. Only 409 (a row exists) and 400 (invalid) are precise. Typed `HttpException`s in `HubPoolPeerService` would let it be specific.

**Dismissal.** `modules/dashboard/helpers/pool-setup-dismissal.ts` stores `ci-hub.pool-setup-dismissed` in `localStorage`, with every read and write in `try/catch` and an in-memory fallback for a browser that blocks storage. It is per browser origin, so the desktop app and each address a Hub is opened at keep their own. It applies to the invite card only, and `clearClientHubState` does not clear it, so a logout does not bring the nudge back.

**Strings.** New guide copy is a `HUB_POOL_SETUP_*` key, added to `packages/common/i18n/translations/en.json` and `en-US.json` only, with identical text (the backend `translation-parity.test.ts` fails otherwise). The other locale files are not edited for new keys, and a missing key falls back to English (`fallbackLng: 'en'`, with the bundled English merged under the fetched locale). The guide also reuses the panel's labels (`HUB_POOL_APPROVE_BUTTON`, `HUB_POOL_CANCEL_REQUEST_BUTTON`, `HUB_POOL_UNPAIR_BUTTON`) and `COMMON_*` buttons, so those read the same in both places. Plurals use the i18next `_one` and `_other` suffixes with `{{count}}`. Labels are deliberately short (**Check**, **Find**, **Choose Hubs**, **Rescan**, **Have a PIN?**): keep new ones to a word or two, and keep the explanatory sentence to one line. A key typo is not a type error, so `pool-setup-i18n.test.ts` scans the guide's sources for keys missing from both files.

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

A bound custom domain that is not serving yet is the one state a customer can see and nobody is told
about, so the report names it: `awaitingCustomDomainRestart`. It is narrower than `pendingRestart`,
which every settings save raises — a surface promising "your domain will not serve" must key on the
narrow flag or it makes that claim constantly and stops being read. It is *wider* than the
`action: 'ok'` bind window, though: an app re-pointed from one bound domain to another is dark too,
and its env is on neither the platform hostname nor the new domain.

`customDomainAwaitingRestart` in `lib/cloudflare-api.ts` is the one predicate over it, and
`CustomDomainRestartBanner` — on the dashboard and on an app's own page — is the surface built on it,
with a **Restart now** action per waiting app. The dashboard tile badge (`SimpleAppTile`) is
deliberately *not* gated on it: it fires on the raw `pendingRestart`, because every stale env is worth
a dot. The narrow flag only chooses the badge's tooltip, so a dark domain is named there instead of
the generic "configuration has changed".

All of them gate on `restartCanApply(status)` — **only a running app is asked to restart**. `repair()`
rewrites the env and returns `success: true` *without* starting a container when the app is not
running, so offering the action anywhere else clears the warning and leaves the domain exactly as
dark. Nothing is owed for a stopped app either (`start-app-command` regenerates the env on the way
up), nor while a start, restart, update, reset or restore is already in flight.

Every surface reads the report under `PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY`, and `invalidateAppQueries`
refreshes it. A hand-written key literal is invisible to that helper, and the banner then keeps asking
for a restart that already happened.

Genuine drift (`action: 'repair'`) raises a banner in the app config dialog carrying its own **Repair routing** action
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
