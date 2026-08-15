# Frontend System — CI-Hub

> **Purpose:** React SPA — dashboard, app store, settings, hub startup gate, real-time logs.
> **Scope:** `packages/frontend/` — React Router 7, TanStack Query, hub-status, API client.
> **Key paths:** `packages/frontend/src/components/hub-status/`, `packages/frontend/src/modules/`, `packages/frontend/src/lib/`
> **Commands:** `cd packages/frontend && pnpm test`, `pnpm run local` (root, port 5004/5005)
> **Owner persona:** code-quality + maintainability
> **Last updated:** 2026-08-14 (iOS working; Hub sign-in reuses existing Portal org)
> **Related:** docs/system/desktop.md, docs/system/e2e.md

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

## Hub status gate

`packages/frontend/src/components/hub-status/hub-status.tsx` blocks the Tauri UI until the Hub API is healthy. **iOS/Android** (the thin-client app, including `ios:dev` / `android:dev`) skip this local-Hub gate and go to `/connect` until a remote Hub is chosen. **Mac / Linux / Windows** (browser or desktop Tauri) always set up a Hub the normal way — registration, login, onboarding. Do not send those clients to cloud connect.

Key behaviors agents must preserve:

- API probe (`/api/health/live`) is the UI gate — not Docker container state alone
- `sessionStorage` steady-state across reloads
- User-initiated reload uses `revalidate()` instead of `window.location.reload()`
- Optional sidecars (Tailscale, cloudflared) must not block `all_ready` or regress UI to startup screen

Tests: `packages/frontend/src/components/hub-status/hub-status.test.tsx`

## API client

- Generated from backend OpenAPI: `pnpm run gen:api-client`
- Tauri release builds probe local ports via `packages/frontend/src/lib/tauri-hub-probe.ts`
- Session refresh: `packages/frontend/src/lib/hub-session-refresh.ts`

## Styling

- Tailwind CSS 4 + Radix UI primitives
- UI style guide: `docs/UI_STYLE_GUIDE.md`
- iOS / Tauri mobile: `html.ci-mobile` sets `--safe-area-top` / `--safe-area-bottom` (WKWebView often reports `env(safe-area-inset-*)` as 0). The fixed Hub header and dashboard `pt` use `--header-offset`. Keep `viewport-fit=cover` in `index.html` and the root Layout. Do not pin `body` color/background with inline styles — theme tokens (`bg-background text-foreground`) must win in dark mode. Do not slide dashboard routes with Framer Motion (`translateX` + `opacity` paints a blank WKWebView). Radix Dropdown/Dialog/Select must be `modal={false}` on a phone so `react-remove-scroll` does not lock `body`. Phone navigation smoke: `packages/frontend/src/lib/ios-navigation.smoke.test.tsx` — add a case when you add a Hub overlay or a new authenticated route.

## Testing

- Vitest + Testing Library
- Mock Tauri via `window.__TAURI_INTERNALS__.invoke`
- Mock `@/lib/tauri-hub-probe` with `vi.hoisted` when intercepting module imports
- Phone navigation: `src/lib/ios-navigation.smoke.test.tsx` (WKWebView white-screen guards — not XCUITest)

## Mobile OIDC (`/connect`)

The iOS/Android thin client signs into the Portal with PKCE and a `cihub://auth/callback` redirect.

- Desktop delivers the callback on `deep-link://new-url`. **iOS does not** — that event is desktop-only. The mobile Rust shell (`packages/mobile/src-tauri/src/lib.rs`) stashes the URL and emits `deep-link-oidc`.
- Safari → "Open with Companion Hub" often **cold-starts** the app. PKCE verifier/state are persisted in `localStorage` (`cihub.oidc.pending`) and `resumePendingOidcLogin()` finishes the exchange on `/connect` mount. The callback URL is peeked (not taken) in Rust and also mirrored to `cihub.oidc.callback` so a `/connect` reload cannot drop it. A warm return must not reload Vite — that killed the in-flight waiter.
- A WKWebView whose document is `cihub://…` or the mobile-dev `tauri://localhost` proxy is a blank black screen on iOS 26. `devUrl` is `http://lvh.me:5005` so the first load skips that proxy. Rust then `navigate()`s to `http://localhost:5005/connect` (ATS only auto-allows cleartext HTTP to `localhost`). Do not pass `--host 127.0.0.1`. Do not call `window.url()` / `navigate()` from overlapping background threads — wry 0.55 unwraps a nil `WKWebView.URL` and the Simulator shows the Apple "Reopen / Report" crash.
- ios:dev IPC: `capabilities/default.json` must list `remote.urls` for `http://localhost:*`. Without that, `event.listen` / `opener` are denied on the Vite origin and Sign in spins forever.
- iOS 26: Info.plist must use Tao's scene (`TaoScene` / `TaoSceneDelegate`, `UIApplicationSupportsMultipleScenes: true`). A "Default Configuration" with no delegate shows a black scene while the webview runs off-screen.
- Do not leave a debug HUD or a second "Connect to your Hub" splash on the phone. Bootstrap sends the user to `/connect` (cloud sign-in) or `/login` (chosen Hub). Switch Hub lives on `/login` and `MobileLoadError`.
- Cloud connect (`/connect`) is **iOS/Android app only** (`isTauriMobileSync`, `VITE_HUB_RUNTIME=mobile`, or `lvh.me`). Mac / Linux / Windows never take that path — not via port 5005, viewport size, or a phone UA in Safari/Chrome. A phone *browser* on a Hub URL still uses normal `/login`.
- After OIDC, list Hubs with `GET /api/users/me/apps?slug=hub` (Bearer access token). `GET /api/devices` needs a better-auth session and returns 401 for the OIDC token. Email/password still uses `/api/devices`.
- Portal URL is `CI_CLOUD_URL` (baked at frontend build). Unset + non-production `CI_HUB_ENVIRONMENT` → `https://hub.companionintelligence.com`. Production → `https://hub.ci.computer`.
- Authorization codes are single-use. Safari + `/connect` resume both try the same code — exchange is memoized per code so the loser does not toast "invalid code".
- After a Hub is chosen, go to `/login` (not `/`). Root must not wait on the remote Hub's registration API on any mobile route.
- `I18nProvider` must not fetch `/api/i18n` on a phone — that `window.fetch` to the remote Hub never settles and leaves the exact "Loading…" screen. Use bundled `en`.
- Hub `/login` Portal SSO on iOS uses the chosen Hub URL (not `localhost:5002`) with `desktop=1` so Safari returns via `cihub://auth?token=…` instead of leaving the user on the Hub in the browser.
- The SSO button email is the **Portal user** from the OIDC `id_token` (or email/password), stored in `ci-hub.portalAccountEmail`. On a phone, that wins over the Hub operator (`hub_operator` is often `support@…` on a shared appliance).
- Hung Hub calls must not spin forever. I18n never gates on "Loading…". Root loader, `/home` session/app-context, and a 6s DOM watchdog all end in Retry + Switch Hub. The HTML boot strip also grows Reload / Connect if React never paints. Do not send a failed app-context load into onboarding.

Tests: `packages/frontend/src/modules/mobile-connect/oidc.test.ts`, `connect-page.test.tsx`

## Agent notes

- Biome forbids non-null assertions (`!`) — use explicit types
- Run scoped tests: `pnpm test -- src/path/to/file.test.tsx`
- Always run `pnpm run local` or `local:desktop` for UI changes
