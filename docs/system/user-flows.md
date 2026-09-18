# User flows — Companion Hub

> **Purpose:** What people actually come to the Hub to do, the screens each journey crosses, and where each journey is documented and tested.
> **Scope:** End-to-end journeys across `packages/frontend`, the desktop bootstrap, and the phone client. Screen-by-screen detail lives in [ui-screens.md](ui-screens.md).
> **Key paths:** `packages/frontend/src/root.tsx` (boot decision), `packages/frontend/src/routes.ts`, `packages/frontend/src/modules/`
> **Commands:** `pnpm run local`, `pnpm exec playwright test e2e/launch-path.spec.ts`
> **Owner persona:** product + code-quality
> **Last updated:** 2026-09-17 (first version)
> **Related:** docs/system/ui-screens.md, docs/system/frontend.md, docs/RESET_RUNBOOK.md, docs/hub-pool.md

---

## Who uses the Hub

There is exactly one role in the Hub's own UI: **the owner-operator**. `user.operator` is a boolean and a Hub has one
local account; everyone else on the Hub arrives as a CI Account organisation member listed under Settings → Security.
Two further audiences touch the UI without being that operator:

- **A guest** — only when `GUEST_DASHBOARD` is set, and only ever sees `GuestDashboard`.
- **An agent or app** — never sees the UI, but the operator provisions its access through Settings → Security → API keys
  and Settings → MCP.

Everything below is the owner-operator unless stated.

## The boot decision

Before any flow starts, `root.tsx`'s `clientLoader` decides which screen the user lands on. Understanding this order
explains most "why am I here?" questions. In sequence (`runClientLoader`, `root.tsx:327-468`):

1. Wait for the Tauri backend-port probe, then re-init the mobile connection (iOS may inject `__TAURI_INTERNALS__` late).
2. **Phone with no Hub chosen** → stay on `/connect`.
3. **Registration lookup.** If the API is not answering yet, stay put on `/device-registration` or `/login` rather than
   redirecting — redirecting `/` here used to cause a flash loop. If the Hub still needs pairing → `/device-registration`.
   If it is already operational and the user is sitting on `/device-registration` → `/login`.
4. **A registered Hub with a degraded public tunnel is deliberately left alone.** It is fully usable locally, so the
   loader does not hijack navigation to the re-pair screen — that would lock the operator out of Settings. The state
   surfaces as `TunnelStatusBanner` on the dashboard instead, and re-pairing is opened from there by choice.
5. **Session check**, time-boxed. On failure, `/` → `/login` so the user never lands on a blank outlet while the
   backend wakes up.
6. **Any non-root path** is handed to that route's own loader.
7. **Root path only:** not configured → `/register`; not signed in and no guest dashboard → `/login`; otherwise `/home`.

On the desktop app, all of this happens *after* `packages/desktop/bootstrap/` has brought the container up and
`window.location.replace(baseUrl)`'d into the web UI.

---

## Flow 1 — First run on a new appliance

> **As a new Hub owner, I want to get from a powered-on appliance to a working dashboard, so that I can start
> installing apps without touching a terminal.**

| Step | Screen | What happens |
|---|---|---|
| 1 | Desktop bootstrap (`bootstrap/index.html`) *or* a browser at `:5002` | Desktop only: Docker check, container start, the `checking`/`starting`/`stuck`/`stopped`/`failed`/`docker` views. |
| 2 | `/device-registration` | Pair the appliance to a CI Account: sign in or create a Portal account, then enter the 6-character code and device ID. Then DNS probing and provisioning. Phases: `unregistered` → `paired` → `provisioning` → `operational`. |
| 3 | `/register` | Create the local operator account. Reached because `isConfigured` is false. |
| 4 | `/onboarding` | The setup wizard — see Flow 2. |
| 5 | `/home` | The dashboard, with a "setup continues in background" toast if installs are still running. |

Steps 2 and 3 are independent gates in different layers: pairing is a *device* fact checked by the root loader,
the local account is a *user* fact checked afterwards. A Hub can be paired but unconfigured, or configured but unpaired.

**Documented:** CI-Docs `getting-started/first-login.mdx`, `portal/device-pairing.mdx`.
**Tested:** `e2e/launch-path.spec.ts` covers four Hub states including the device-registration gate; `e2e/auth.spec.ts`
and `e2e/ftue.spec.ts` cover register → onboarding.

## Flow 2 — The setup wizard

> **As a new owner, I want the Hub to pick sensible AI defaults for my hardware, so that I do not have to
> understand inference backends to get a working system.**

`/onboarding` is a single scrolling page with one action at the bottom, not a multi-page stepper — there is no progress
rail. Two phases: `form`, then `installing`.

Order as rendered (`onboarding-page.tsx:334-382` and the `StepSection number=` values):

| # | Section | Status |
|---|---|---|
| — | System overview — OS, CPU, RAM, GPU, VRAM, storage, plus GPU runtime guidance and Rescan | unnumbered, top |
| 1 | **How to access your Hub** — Cloudflare or Private VPN; Tailscale setup renders inline when chosen | recommended |
| 2 | **Choose your AI agent** — agent frameworks | recommended |
| 3 | **Set up inference** — backend selection plus one backend card | **required** |
| — | Resource summary bar | unnumbered |
| 4 | **Choose AI models** — recommended models, then other models by size | recommended |
| 5 | **Personal Memory Database** — Companion Memory | — |
| 6 | **Recommended Private Apps** — a category-grouped "instead of X, run Y" replacement table | optional |
| 7 | **Advanced** — cloud provider keys (OpenAI, Anthropic, Google AI, GitHub Copilot) | optional, collapsed by default |

The footer is sticky and pinned to the bottom on mobile; its button reads **Install & Finish** (`finish-setup-btn` is
only the test id). Then `InstallStep` runs the queue and calls `completeOnboarding()` with one retry on 0/5xx. On
failure it stays put with an `onboarding-complete-failed` alert rather than stranding the user.

The wizard is one-time, but re-runnable from **Settings → System → Restart Setup Wizard**.

**Documented:** CI-Docs `getting-started/onboarding-wizard.mdx` — **stale**: its step order, six of its step titles, and
its "Recommended Apps" section all describe a previous design. See the CI-Docs review for the specifics.
**Tested:** `e2e/future/onboarding-ai-setup.spec.ts` has the only real body coverage (14 tests) and runs in a
dispatch-only lane. The default lane asserts the first heading only.

## Flow 3 — Returning sign-in

> **As the operator, I want to get back into my Hub quickly, whether or not I have internet.**

| Path | Screens |
|---|---|
| Local account | `/login` → username + password → `/home` |
| CI Account SSO | `/login` → "Sign in with your CI Account" → system browser (desktop) or same tab → back to `/home` |
| With 2FA on | `/login` → credentials → `TotpForm` → `/home` |
| Forgotten password | `/login` → `/reset-password` → request, then `/reset-password?token=…` |

`/login` renders a banner explaining *why* the user was signed out when it knows. On desktop the Portal path
deliberately opens the system browser: a same-origin `<a href>` breaks desktop SSO (see `docs/system/frontend.md`).

**Tested:** `e2e/auth.spec.ts`, `e2e/error-states.spec.ts` (bad password, unknown user, disabled submit).
`/reset-password` has a unit test but no e2e coverage.

## Flow 4 — Find and install an app

> **As the operator, I want to find a self-hosted app and have it running on a URL I can reach, so that I stop
> paying for the hosted equivalent.**

| Step | Screen | Notes |
|---|---|---|
| 1 | `/store` | Lands on the **featured** view, not a full category list. Sidebar has categories, All, Alternatives, and Expose a port. |
| 2 | `/store` search or a category, or Alternatives | Alternatives is the "replace proprietary software" entry point; unmapped alternatives show a **Soon** badge. |
| 3 | `/store/:storeId/:appId` | Hero, media gallery, About, Information (including the Marketplace `gpu_requirements` disclosure), access points. |
| 4 | Install dialog / install form | Config, exposure mode, domain. |
| 5 | Toast + `/home` | Install progress arrives over SSE as toasts; the dashboard shows queued installs. |
| 6 | `/apps/:storeId/:appId` → Open | The app's own URL, resolved as `LOCAL_DOMAIN` → `DOMAIN` → `localhost`. |

**Documented:** CI-Docs `features/app-store.mdx`, `getting-started/installing-first-app.mdx`,
`finding-your-app-url.mdx`. Both of the latter say the App Store is "in the sidebar" — Hub navigation is a top header bar.
**Tested:** steps 1–2 only (`apps.spec.ts`, `app-store-browsing.spec.ts`, `multi-store-context.spec.ts`). Steps 3–6 have
no runnable e2e coverage because no fixture seeds a running app.

## Flow 5 — Expose something that is not a marketplace app

> **As the operator, I want to put a service I already run behind my Hub's domain and TLS.**

`/store` sidebar → **Expose a port** → `/apps/expose`: name, port, exposure mode (local / Cloudflare / Tailscale),
subdomain with a DNS availability check → `/apps/:appId` rendered as `PortExposeDetailsView`.

**Documented:** nowhere, in either repo.
**Tested:** nothing — no unit test, no e2e.

## Flow 6 — Run a custom app from a compose file

> **As an advanced operator, I want to run my own Docker Compose service under the Hub's lifecycle and routing.**

`/apps/create` → `MultiServiceForm` (Essentials / Environment / Volumes / Ports / Advanced, plus a JSON editor) →
`/apps/:appId` → edit later at `/apps/:appId/edit`.

**This flow has no entry point in the UI.** `/apps/create` is not linked from anywhere; it is reachable only by typing
the URL. It also renders without a page heading or a back affordance.

**Documented:** conceptually in CI-Docs `features/index.mdx` and `apps-available/community-apps.mdx`; the screens are not.
**Tested:** nothing.

## Flow 7 — Change inference backend or models

> **As the operator, I want to change which models my agents use as my hardware or needs change.**

`/settings?tab=ai` — system overview and Rescan, recommended models (pre-selected for the detected tier), other models
grouped by parameter count, downloaded models, backend selection (Ollama, vLLM, Lemonade, MTPLX, mlx-dspark,
Speculative inference), an Ollama-embeddings sub-section for host-served backends, cloud provider keys → **Save AI
Settings**, which pulls and pins the selection.

**Documented:** CI-Docs `features/inference-and-ai.mdx` — its backend table omits MTPLX and mlx-dspark, and it describes
"Speculative inference" using mlx-dspark's port and env var.
**Tested:** unit tests on `ai-settings` containers; no e2e.

## Flow 8 — Pool this Hub with others

> **As an operator with several machines, I want one Hub to borrow another's GPU, so that a request lands wherever
> the model already is.**

`/settings?tab=network` → Hub Pool: three switches (pool inference, send work, serve work), local affinity, peer health
interval, routing pins, the paired-Hubs table, a pairing PIN and fingerprint, discoverable devices, pending requests.
Outcomes are then watched on `/resource-monitor`.

This is the densest screen in the app — on a nine-node pool it stacks Private VPN, the whole pool panel, Cloudflare
Tunnel, and account removal into one unsegmented scroll with no in-page navigation.

**Documented:** `docs/hub-pool.md`, `docs/hub-pool-fleet-testing.md` (mechanism, not the screen).
**Tested:** nothing at the UI level.

## Flow 9 — Attach a phone

> **As the owner, I want my phone to reach my Hub without typing an IP address.**

`/connect` → Portal OIDC in the system browser → pick a device → the app stores that Hub and continues to `/login`.
`/connect/advanced` allows a custom Portal URL or an email + password fallback. If the chosen Hub later stops
answering, the phone shows `MobileLoadError` with a retry — mobile deliberately skips the desktop `HubStatus` gate.

**Documented:** nowhere. CI-Docs' mobile pages do not cover these screens.
**Tested:** unit tests on both pages; no e2e (the default lane runs desktop Chromium only).

## Flow 10 — Give an agent access

> **As the operator, I want an agent to drive my Hub, so that it can install and manage apps for me.**

`/settings?tab=security` → API keys → Create key (capability, scope, audience; the raw value is shown once) →
`/settings?tab=mcp` to confirm the server is enabled, browse the tool catalog, and see installed MCP apps.

⚠ In the **Installed MCP servers** table, the app name links to `/app-store/<appName>/<appStoreId>`. There is no
`/app-store` route and the segments are reversed relative to `/store/:storeId/:appId`, so the link lands on the 404
page (`mcp-settings.tsx:292`).

**Documented:** CI-Docs `connect/api-keys.mdx`, `connect/hub-mcp.mdx`.
**Tested:** `api-keys` and `mcp-settings` have unit tests; the MCP link is not asserted.

## Flow 11 — Watch and diagnose

> **As the operator, I want to know whether my Hub is healthy and where its resources are going.**

| Question | Screen |
|---|---|
| Is anything wrong right now? | `/home` tiles, plus banners (core server, tunnel, app runtime degraded) |
| Where is CPU / RAM / GPU going? | `/resource-monitor` — KPI rail, per-workload trends, containers, pool nodes, pool activity |
| What are the containers and ports doing? | `/settings?tab=system` → system inspector (polls every 5s) |
| What did the Hub just log? | `/settings?tab=logs` — Follow, Wrap, Max lines, Download full logs. No filter, no search. |

**Documented:** CI-Docs `features/system-inspector.mdx` and `troubleshooting/log-viewer.mdx` (the latter documents a
service filter and a search box that do not exist). `/resource-monitor` is documented nowhere despite being one of
three primary nav destinations.
**Tested:** `/resource-monitor` has no test of any kind.

## Flow 12 — Recover

> **As the operator, I want to get back to a known-good state after something breaks, without losing what I can keep.**

| Situation | Path |
|---|---|
| Public tunnel degraded | Dashboard `TunnelStatusBanner` → Reconnect, or open `/device-registration` to re-pair |
| Registration drifted, apps missing | `RegistrationRestoreBanner` / drift dialog → `/restore-apps` → review plan → re-install |
| Memory app needs reconnecting | App details → connect → `/memory-connect/finishing` polls while the app restarts |
| Start over | `/settings?tab=system` → **Factory reset Hub** — erases operators, installed apps, device registration and local app data, then returns to first-run setup |
| Remove from the account | `/settings?tab=network` → This Hub in your account → Remove, which opens the Portal |

**Documented:** `docs/RESET_RUNBOOK.md` — the closest thing to a user-flow doc the Hub repo had before this file.
**Tested:** `/restore-apps` has a unit test; `launch-path.spec.ts` covers the degraded state. Factory reset has no e2e.

---

## Coverage of the flows

| Flow | Documented | E2E |
|---|---|---|
| 1 First run | ✅ CI-Docs | ✅ `launch-path`, `auth`, `ftue` |
| 2 Setup wizard | ⚠ stale | ⚠ dispatch-only lane |
| 3 Returning sign-in | ✅ | ✅ |
| 4 Find and install | ✅ (two location errors) | ⚠ browse only |
| 5 Expose a port | ❌ | ❌ |
| 6 Custom app | ⚠ concept only | ❌ |
| 7 Inference and models | ⚠ incomplete | ❌ |
| 8 Hub pool | ⚠ mechanism only | ❌ |
| 9 Attach a phone | ❌ | ❌ |
| 10 Agent access | ✅ | ⚠ partial |
| 11 Watch and diagnose | ⚠ two wrong pages | ❌ |
| 12 Recover | ✅ runbook | ⚠ partial |

The pattern: the flows a *new* owner walks are documented and tested; the flows a *settled* owner walks — exposing a
port, running a custom app, tuning inference, pooling Hubs, watching resources — are largely neither.
