# UI screens — Companion Hub

> **Purpose:** The screen inventory. Every route the frontend serves, what the user does there, what gates it, and what covers it.
> **Scope:** `packages/frontend/src/routes.ts` and the page components it names, plus the non-route surfaces (shell, startup gates, desktop shell).
> **Key paths:** `packages/frontend/src/routes.ts`, `packages/frontend/src/modules/*/pages/`, `packages/frontend/src/components/`
> **Commands:** `pnpm run local` (source dev stack), `pnpm exec playwright test` (default e2e lane)
> **Owner persona:** code-quality + maintainability
> **Last updated:** 2026-09-17 (first version — inventory, gates, and measured coverage)
> **Related:** docs/system/frontend.md, docs/system/e2e.md, docs/UI-STYLE-GUIDE.md, docs/DESKTOP-UI-ARCHITECTURE.md, docs/system/user-flows.md

---

## How to read this

`packages/frontend/src/routes.ts` is 53 lines and is the whole route table — there is no file-system routing and no
dynamic route registration. React Router 7 runs in **framework mode with `ssr: false`** (`react-router.config.ts`), so
every route below is served by the same SPA shell and the Hub's Docker image serves that shell for any path.

Two `layout()` wrappers do all the gating. Everything else is a leaf.

The **Tests** columns are measured, not asserted. Regenerate them with:

```bash
# unit test present for each route component
for f in $(grep -oE "\./(modules|routes|components)/[^']*\.tsx" packages/frontend/src/routes.ts | sort -u); do
  p="packages/frontend/src/${f#./}"; [ -f "${p%.tsx}.test.tsx" ] && echo "TEST $f" || echo "  -  $f"
done

# default-lane e2e specs that navigate to a route
grep -rl "goto('/store" e2e | grep -v "/future/\|/generated/\|/platform/\|/cross-domain/"
```

## Screens outside both guards

These render with no header, no nav, and no auth wrapper. Each gates itself.

| Route | Component | What the user does | Self-gate | Unit | E2E |
|---|---|---|---|---|---|
| `/connect` | `modules/mobile-connect/pages/connect-page.tsx` | Phone only: sign in to Portal, then pick which Hub device this phone attaches to. Two internal steps, `sign-in` → `pick`. | `clientLoader` redirects to `/login` if a Hub is already stored, or to `/` when the client is not a phone | ✅ | — |
| `/connect/advanced` | `modules/mobile-connect/pages/connect-advanced-page.tsx` | Custom Portal URL, or email + password Portal fallback. | Re-exports `connect-page.tsx`'s `clientLoader` | ✅ | — |
| `/onboarding` | `modules/onboarding/pages/onboarding-page.tsx` | The first-run setup wizard. See [user-flows.md](user-flows.md). | `!isLoggedIn` → `/login`; `hasCompletedOnboarding` → `/home` | ✅ | heading only (`ftue.spec.ts`) |
| `/restore-apps` | `modules/auth/pages/restore-apps-page.tsx` | Re-install apps this Portal device had before a registration-state drift. Shows the plan and the queued / started / skipped lists. | `!isLoggedIn` → `/login`; an inner `allowed` gate reads `getRehydrateStatus` + the stored drift choice, else `/home` | ✅ | — |
| `/memory-connect/finishing` | `modules/app/pages/memory-connect-finishing-page.tsx` | Full-page interstitial after the CI Memory OAuth callback. Polls app status and public-URL availability while the app restarts, then forwards to `?next=`. | `!isLoggedIn` → `/login`; missing `?app=` → `/home` | ✅ | — |
| `*` | `routes/not-found.tsx` | 404. One "Home" button. | none — sits outside both layouts, which is why it has no chrome | — | — |

## Unauthenticated screens

`layout('./components/routes/unauthenticated-route.tsx')` wraps these in `RouteWrapper` → `Suspense` → `AuthLayout`.
`AuthLayout` takes its `wide` variant only on `/device-registration`.

| Route | Component | What the user does | Unit | E2E |
|---|---|---|---|---|
| `/login` | `modules/auth/pages/login-page.tsx` | Sign in: local username + password, Portal SSO (opens the system browser on desktop), TOTP second factor, and a banner explaining why they were signed out. `clientLoader`: already signed in → `/home`; Hub not yet configured → `/register`. | ✅ | ✅ `auth`, `dashboard`, `error-states` |
| `/register` | `modules/auth/pages/register-page.tsx` | First run: create the Hub's single local operator account. `clientLoader`: signed in → `/home`; already configured → `/login`. | ✅ | ✅ `auth`, `ftue`, `launch-path` |
| `/reset-password` | `modules/auth/pages/reset-password-page.tsx` | Two modes in one page: request a reset, or — with `?token=` — verify the token and set a new password. | ✅ | — |
| `/device-registration` | `modules/auth/pages/device-registration-page.tsx` | **Pair this appliance to a CI Account.** Two step columns: sign in or create a Portal account, then enter the 6-character pairing code and device ID. Then DNS probing and provisioning progress. Internal phases: `unregistered` → `paired` → `provisioning` → `degraded` / `operational`. | ✅ | ✅ `launch-path` |

At 931 lines, `device-registration-page.tsx` is the largest page in the app, and it is the first screen a new owner sees.

## Authenticated screens

`layout('./components/routes/authenticated-route.tsx')` gates all of these. In order, as the code runs:

1. mobile client and the session query timed out → `MobileLoadError`
2. session query still loading → full-screen spinner
3. `!isLoggedIn && !isGuestDashboardEnabled` → `/login`
4. `isGuestDashboardEnabled && !isLoggedIn` → renders `GuestDashboard` **in place of the entire route tree**
5. drift choice is `restore` and restore is pending → `/restore-apps`
6. app-context loading → chrome paints with a spinner in the content area
7. `!loadFailed && !user.hasCompletedOnboarding` → `/onboarding`

Then `RouteWrapper` → `QueryErrorResetBoundary` → `ErrorBoundary` → `Suspense` → `AppContextProvider` → `SSEProvider` → `DashboardLayout`.

Step 7 is deliberately conditioned on `!loadFailed`: a failed load is not an answer, and deciding on the default
payload (which says `false`) used to walk an onboarded operator into the wizard. The same redirect is repeated in
`components/layouts/dashboard/layout.tsx:73` with an added pathname guard — two places to keep in sync.

| Route | Component | What the user does | Unit | E2E |
|---|---|---|---|---|
| `/home` | `modules/dashboard/pages/dashboard.tsx` | Disk / CPU / memory tiles and the installed-app list. Surfaces `?memoryConnect=` result toasts and the "setup continues in background" toast. | — | ✅ `dashboard`, `navigation` (via nav click) |
| `/store` | `modules/app/pages/app-store-page.tsx` | Browse and search the marketplace. Lands on the **featured** view, not a full category listing. Category grid, alternatives catalog, infinite scroll, pull-stores refresh. | ✅ | ✅ `apps`, `app-store-browsing`, `multi-store-context` |
| `/store/:storeId` | *same component* | The same browser scoped to one app store. | ✅ | ✅ `multi-store-context` |
| `/store/:storeId/:appId` | `modules/app/pages/app-details-page.tsx` | App listing: hero, media gallery, About / Information, access points, MCP access, memory status, runtime-degraded banner, and the install / start / stop actions. `clientLoader`: `storeId === '_user'` → `/apps/:appId`. | ✅ | — |
| `/store/:storeId/:appId/update` | `modules/app/pages/app-update-page.tsx` | Review the compose and config diff for an available update, then apply it. `clientLoader`: missing params or unknown app → `/apps`. | ✅ | — |
| `/apps` | `modules/app/pages/apps-redirect.tsx` | Nothing — a 3-line redirect to `/store`. | — | — |
| `/apps/create` | `modules/app/pages/custom-app-create-page.tsx` | Define a custom app from a Docker Compose definition. **Unreachable from the UI** — no link anywhere; URL only. | — | — |
| `/apps/expose` | `modules/app/pages/port-expose-create-page.tsx` | Expose a local port: name, port, exposure mode (local / Cloudflare / Tailscale), subdomain, DNS availability check. Linked from the store sidebar. | — | — |
| `/apps/:appId/edit` | `modules/app/pages/custom-app-edit-page.tsx` | Edit a custom app's compose config. `clientLoader`: no `appId` or no compose diff → `/apps`. Linked from `AppActions`. | — | — |
| `/apps/:appId` | `modules/app/pages/custom-app-details-page.tsx` | Custom-app detail, or `PortExposeDetailsView` when `isPortExposeApp`. | — | — |
| `/apps/:storeId/:appId` | `modules/app/pages/app-details-page.tsx` | Installed-app detail. Same component as the store listing. | ✅ | — |
| `/apps/:storeId/:appId/update` | `modules/app/pages/app-update-page.tsx` | Installed-app update review. | ✅ | — |
| `/settings` | `modules/settings/pages/settings-page.tsx` | Eight tabs — see below. | ✅ | ✅ `settings`, `navigation`, `dev-mode` |
| `/resource-monitor` | `modules/system/pages/resource-monitor-page.tsx` | Pool and workload dashboard. One of the three primary nav destinations. | — | — |

## Settings tabs

`/settings` is one route with eight lazily-imported panels. The tab is carried in `?tab=`, which reads **and** writes:
opening `/settings?tab=network` selects Network, and clicking a tab updates the URL — so a tab is deep-linkable,
shareable, and survives a reload. Below `sm`, the eight triggers become one horizontally scrolling strip; there is
deliberately no "More" dropdown (`settings-page.tsx:48-55` explains why).

| `?tab=` | Container | What the user does |
|---|---|---|
| `settings` *(default)* | `containers/user-settings.tsx` | Advanced Mode, language, base theme, guest dashboard, error monitoring, default app CPU limit, auto themes, timezone, local and public domain, certificate download. |
| `security` | `containers/security.tsx` + `containers/api-keys.tsx` | Change username, change password, enable TOTP, see the people on this Hub, and create / re-scope / revoke API keys. |
| `appstores` | `containers/app-stores-container.tsx` | Add, edit and delete app-store sources. |
| `network` | `containers/network-settings.tsx` + `hub-account-settings.tsx` + `hub-pool-settings.tsx` | Private VPN (Tailscale), Hub Pool (peers, routing switches, affinity, routing pins, paired Hubs, pairing PIN, discoverable devices), Cloudflare Tunnel, and removing this Hub from the account. **The densest screen in the app.** |
| `ai` | `containers/ai-settings.tsx` | System overview, recommended and other models, downloaded models, inference backend, cloud provider keys. Deep-linkable further as `?tab=ai&section=rocm`. |
| `mcp` | `containers/mcp-settings.tsx` | MCP server status, installed MCP apps, API keys shortcut, tool catalog. |
| `system` | `containers/general-actions.tsx` + `containers/system-inspector.tsx` | Hub stack version and update, desktop app update, update app stores, re-run the setup wizard, **factory reset**, then the system inspector (storage, host resources, health, containers, ports). |
| `logs` | `containers/logs.tsx` | Live log terminal. Controls are Follow logs, Wrap lines, Max lines, and Download full logs — there is no service filter and no search. |

## Non-route surfaces

These have no URL but are screens in every other sense.

| Surface | Path | When the user sees it |
|---|---|---|
| `Header` | `components/header/header.tsx` | Always, when authenticated. **The only nav.** Logo / device name, centre links (Home · App Store · Resources) shown at `lg` and up, theme toggle, settings, logout. |
| `MobileAppMenu` | `components/header/header.tsx` | Below `lg` — the same links plus theme and logout in a hamburger dropdown. |
| `Titlebar` | `components/titlebar/titlebar.tsx` | Desktop only. Native decorations are suppressed in `tauri.conf.json`, so the web app draws the window chrome. |
| `HubStatus` / `StartupScreen` | `components/hub-status/hub-status.tsx` (1555 lines) | Desktop only, before the app: `starting` / `stopped` / `failed`, then the Docker install guides. Mobile bypasses it entirely. |
| `GuestDashboard` | `modules/dashboard/pages/guest-dashboard.tsx` | Only when `GUEST_DASHBOARD` is set and the visitor is anonymous. |
| `MobileLoadError` | `components/mobile/mobile-load-error.tsx` | Phone, when the chosen Hub does not answer in time. |
| `ErrorPage` | `components/error/error-page.tsx` | Any uncaught render error inside the authenticated tree. Stack traces only in dev. |
| `EmptyPage` | `components/empty-page/empty-page.tsx` | Empty lists. |
| Banners | `components/core-server-banner/`, `components/tunnel-status-banner/`, `modules/app/components/app-runtime-degraded-banner.tsx`, `modules/auth/components/registration-state-drift-dialog.tsx` | Above page content, per condition. |
| Toasts | `react-hot-toast`, `<Toaster position="bottom-center" />` mounted twice in `root.tsx` (the two branches are mutually exclusive) | Install / start / stop / uninstall events via `SSEProvider`, and most mutation results. |
| `DebugPanel` | `components/debug-panel/debug-panel.tsx` | Dev builds only, by holding `d`+`e`+`v`. The only global keyboard affordance in the app — there is no command palette. |
| Dialogs | `modules/app/components/dialogs/` (11), `modules/settings/components/` (7) | Install, uninstall, stop, force-stop, restart, reset, cancel-install, update-settings, app-data-folder, disconnect-memory, memory-provider-force-warning; add / edit / delete app store, advanced settings, update repo, change username, OTP. |

## Desktop shell surfaces that are not React

Per [DESKTOP-UI-ARCHITECTURE.md](../DESKTOP-UI-ARCHITECTURE.md) the container is the source of truth for product UI, so
the Tauri shell renders only what must exist before the container answers.

| Surface | Path | Notes |
|---|---|---|
| Bootstrap splash | `packages/desktop/bootstrap/{index.html,bootstrap.js,bootstrap.css}` | `frontendDist` points here. Six views — `checking`, `starting`, `stuck`, `stopped`, `failed`, `docker` — plus a hand-built titlebar. Deliberately mirrors the React `StartupScreen`; `bootstrap.js` hands off with `window.location.replace(baseUrl)`. |
| Tray menu | `packages/desktop/src-tauri/src/tray.rs` | Show/Hide, Start, Stop, Account Management, View Logs, Clear Tunnel Token, a live Status row, Quit. Closing the window hides to tray. |
| Updater | `packages/desktop/src-tauri/src/updater.rs` | Logic only. All update UI is web-side: the `use-update-checker` toast and `/settings?tab=system`. |

`packages/mobile` adds **no** screens of its own. It points `frontendDist` at the same frontend build and contributes
only deep-link plumbing.

## Screens hidden behind flags

| Gate | Effect |
|---|---|
| `GUEST_DASHBOARD` | Replaces the whole authenticated tree with `GuestDashboard` for anonymous visitors. The only way to reach that screen. |
| `DEMO_MODE` | Blocks destructive actions; surfaces as a `SERVER_ERROR_NOT_ALLOWED_IN_DEMO` toast. |
| `VITE_HUB_RUNTIME=mobile` | Skips the `HubStatus` gate and the `Titlebar`, time-boxes loaders, routes to `/connect`. |
| `import.meta.env.DEV` | `DebugPanel`, the blank-page overlay, and stack traces in `ErrorPage`. |
| `cloudflareAvailable` / `tailscaleAvailable` | Runtime capabilities, not env — hide exposure-mode options in the access card, install form, and port-expose page. |
| `isTauri` / `isTauriMobileSync()` | Hide `Titlebar`, the startup gate, and self-update on web and mobile. |

## Measured coverage

24 route entries resolve to 24 distinct components (`app-details-page` and `app-update-page` each serve two routes).

- **Unit tests: 14 of 24 components.** Missing: both route guards, `apps-redirect`, `custom-app-create`,
  `custom-app-details`, `custom-app-edit`, `port-expose-create`, `dashboard`, `resource-monitor`, `not-found`.
- **Default-lane e2e: 8 routes reached.** `/login`, `/register`, `/device-registration`, `/store`, `/store/:storeId`,
  `/home`, `/settings`, plus `/onboarding`'s first heading. (`/` is exercised too, by `ftue.spec.ts`'s redirect
  assertion, but it is a root-loader decision rather than a route entry.)
- **Zero coverage of any kind:** `/apps/create`, `/apps/expose`, `/apps/:appId`, `/apps/:appId/edit`,
  `/resource-monitor`, `/apps` and `*`.
- **Unit-tested but never reached by a runnable e2e test:** `/reset-password`, `/restore-apps`,
  `/memory-connect/finishing`, `/connect`, `/connect/advanced`, and both app-details and app-update screens.

The app-details gap is structural rather than neglect: no fixture seeds a *running* app, so reaching those screens in a
test needs real Docker, a `CI-Marketplace` checkout, Traefik, and wildcard DNS. An "installed app" fixture is the single
highest-leverage addition for UI coverage — it would unlock four screens at once.

Visual coverage is separately documented in [e2e.md](e2e.md).
