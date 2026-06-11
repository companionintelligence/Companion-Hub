# Companion Intelligence — Platform Walkthrough Video

**Format:** 1920×1080 @ 30fps · Remotion (code-rendered)
**Target length:** ~3:05 (185 s)
**Theme:** Dark UI screenshots on the CI dark palette (teal `#0f717a` primary on deep navy, Montserrat). Captions in Montserrat 600; narration calm, plain-spoken.
**Total narration:** ~390 words.

All routes referenced below were verified against the routers in code:
- Portal: `CI-Portal/apps/web-app/src/routes/` (TanStack Router file routes)
- Hub: `CI-Hub/packages/frontend/src/routes.ts` (React Router 7 config)
- Marketplace catalog: `CI-Marketplace/apps/<slug>/config.json` + `metadata/`

---

## Scene 01 — Cold open / brand intro
- **Duration:** 8 s (frames 0–239)
- **Kind:** brand-intro
- **Visual:** Black-to-navy gradient. CI logo mark fades in at center, scales 0.92→1.0 with a soft ease. Wordmark "Companion Intelligence" types on beneath it. A thin teal rule draws left-to-right. No UI yet.
- **Caption:** `Your data. Your hardware. Your AI.`
- **Narration:** "This is Companion Intelligence. AI that runs on hardware you own, with data that never has to leave your home."
- **Screens needed:** none (pure Remotion graphics; logo asset from `CI-Hub/packages/frontend/public/icons/`).

## Scene 02 — Platform overview diagram
- **Duration:** 18 s (240–779)
- **Kind:** diagram
- **Visual:** Animated architecture diagram, built in Remotion (no screenshots). Three nodes appear in sequence with connecting lines: **Portal** (cloud, hub.ci.computer) → **Hub** (your appliance) ← **Marketplace** (app catalog). A fourth quiet node, **Server (memory)**, docks beside the Hub. Arrows pulse once along each edge as it's named. Labels: "Cloud control plane", "Your appliance", "App catalog".
- **Caption:** `Three pieces. One private platform.`
- **Narration:** "Three pieces work together. The Portal is the cloud control plane for accounts and devices. The Hub is the runtime on your own machine. And the Marketplace is the catalog of apps the Hub can install."
- **Screens needed:** none.

## Scene 03 — Portal: create your account
- **Duration:** 16 s (780–1259)
- **Kind:** screen-walkthrough
- **Visual:** Browser-framed screenshot of Portal sign-up. Slow push-in (1.0→1.06 scale) on the form. Cursor overlay fills email + password fields (animated, simulated). Cut to logged-in state. URL bar shows `hub.ci.computer/signup`.
- **Caption:** `hub.ci.computer — create a free account`
- **Narration:** "Start at hub dot ci dot computer. Create a free account — it manages your devices and apps, not your data."
- **Screens needed:** `portal-signup`, `portal-login` (alt take).

## Scene 04 — Portal: your workspace + add a device
- **Duration:** 18 s (1260–1799)
- **Kind:** screen-walkthrough
- **Visual:** Portal `/home` workspace: workspace header (org name, device count, app count), app launcher grid, devices sidebar on the right. Highlight ring lands on the "Add device" action in the sidebar. The "Name your device" dialog opens (field placeholder: "e.g. Living Room Server", slug preview below).
- **Caption:** `One dashboard for every device you own`
- **Narration:** "Your home screen shows every device and every app in one place. To bring a new machine in, add a device and give it a name."
- **Screens needed:** `portal-home`, `portal-add-device-dialog`.

## Scene 05 — Portal: the pairing code
- **Duration:** 12 s (1800–2159)
- **Kind:** screen-walkthrough
- **Visual:** The "Device Pairing Code" dialog: large monospace 6-character code in a teal-bordered card. Gentle glow pulse on the code. Copy button micro-interaction.
- **Caption:** `One code claims your Hub`
- **Narration:** "The Portal hands you a one-time pairing code. That code is how your Hub proves it belongs to you."
- **Screens needed:** `portal-pairing-code-dialog`.

## Scene 06 — Hub: claim the device
- **Duration:** 16 s (2160–2639)
- **Kind:** screen-walkthrough
- **Visual:** Cut to the Hub UI (dark, Montserrat) at `/device-registration`. Pairing-code input focused; the 6 characters type in. Status card advances through real phases from the page: "Checking status…" → "Provisioning your domain" → "Setting up Hub" → complete. Subtle progress shimmer between states.
- **Caption:** `Enter the code on your Hub`
- **Narration:** "On the Hub, enter the code. It registers with the Portal, gets its own secure domain, and finishes setting itself up."
- **Screens needed:** `hub-device-registration-empty`, `hub-device-registration-provisioning`, `hub-device-registration-complete`.

## Scene 07 — Hub: first-boot onboarding
- **Duration:** 16 s (2640–3119)
- **Kind:** screen-walkthrough
- **Visual:** Hub `/onboarding` — "Set up your Hub" wizard. Slow vertical pan down the steps: AI setup (local models via Ollama, agent frameworks, remote access), then Step 4 "Recommended Apps" with detected services. Sticky footer button "Install & Finish" gets a highlight ring; click → install progress phase.
- **Caption:** `Local AI, configured in one pass`
- **Narration:** "First boot walks you through setup: pick your local AI models, choose remote access, and select your starter apps. One click installs everything."
- **Screens needed:** `hub-onboarding-form`, `hub-onboarding-installing`.

## Scene 08 — Hub: home dashboard
- **Duration:** 14 s (3120–3539)
- **Kind:** screen-walkthrough
- **Visual:** Hub `/home`: three system stat cards (Disk Space, CPU, Memory) animate their progress bars; installed-apps row beneath. Numbers count up on entry. This is the "it's alive on my hardware" beat.
- **Caption:** `Running on your machine — and you can see it`
- **Narration:** "This is home. Real disk, real CPU, real memory — your apps running on a machine you can point to."
- **Screens needed:** `hub-home-dashboard`.

## Scene 09 — App Store: browse the catalog
- **Duration:** 18 s (3540–4079)
- **Kind:** screen-walkthrough
- **Visual:** Hub `/store`: search bar, category sidebar, grid of app cards with real logos. Slow horizontal drift across the grid, then quick highlight passes over flagship cards: Immich, Jellyfin, Home Assistant, Nextcloud, n8n, Open WebUI, Vaultwarden, Pi-hole. Then a second row beat for CI-exclusive apps: Companion Earth, Photo Time Machine, Just In Case, Spellbook.
- **Caption:** `200+ self-hosted apps, one click away`
- **Narration:** "The App Store is fed by the open Marketplace catalog — over two hundred apps. Photos, media, automation, password management — plus Companion-exclusive apps you won't find anywhere else."
- **Screens needed:** `hub-store-grid`, `hub-store-ci-category`.

## Scene 10 — App detail + install lifecycle
- **Duration:** 20 s (4080–4679)
- **Kind:** screen-walkthrough
- **Visual:** Hub `/store/:storeId/immich` app-details page: logo, description, About panel (Provider, Categories, Download size), App Privacy card ("No data collected"). Install button click → install dialog with the app's form fields → status badge timeline animates through the real lifecycle states: `installing → starting → running`. A small state-machine strip at the bottom of frame mirrors the badge.
- **Caption:** `installing → starting → running`
- **Narration:** "Open an app to see exactly what it is and what it collects — which, on your own hardware, is nothing. Hit install, and watch it move from installing to running."
- **Screens needed:** `hub-app-details-immich`, `hub-install-dialog-immich`, `hub-app-installing-immich`, `hub-app-running-immich`.

## Scene 11 — The app, live on your hardware
- **Duration:** 12 s (4680–5039)
- **Kind:** screen-walkthrough
- **Visual:** Click "Open" — cut to the installed app's own UI (Immich library view) in a browser frame on a `*.ci.computer` (or `.ci.localhost`) subdomain. Hold, slow push-in. The payoff shot.
- **Caption:** `Your photos. Your server. No subscription.`
- **Narration:** "And there it is — a full photo library, served from your own machine, reachable from anywhere through your own secure domain."
- **Screens needed:** `app-immich-live` (NEEDS REVIEW — requires an actual installed Immich instance; see notes).

## Scene 12 — Portal: the fleet view ties it together
- **Duration:** 12 s (5040–5399)
- **Kind:** screen-walkthrough
- **Visual:** Return to Portal `/home`. The devices sidebar now shows the new device online; the app launcher grid shows the installed app with its store logo. A teal connector line animates from the device card to the app tile — visually closing the loop from Scene 02's diagram.
- **Caption:** `Every device, every app — one quiet dashboard`
- **Narration:** "Back in the Portal, your device is online and your apps are one click away — from anywhere, on every device you own."
- **Screens needed:** `portal-home-with-device`.

## Scene 13 — Outro / CTA
- **Duration:** 5 s (5400–5549)
- **Kind:** outro
- **Visual:** Cut to brand frame from Scene 01. Logo settles; URL `ci.computer` fades in below with the teal rule. Hold 2 s, fade to black.
- **Caption:** `ci.computer`
- **Narration:** "Companion Intelligence. Own your AI."
- **Screens needed:** none.

---

## Timing summary

| # | Scene | Seconds | Running total |
|---|-------|---------|---------------|
| 01 | Brand intro | 8 | 0:08 |
| 02 | Platform diagram | 18 | 0:26 |
| 03 | Portal sign-up | 16 | 0:42 |
| 04 | Portal workspace + add device | 18 | 1:00 |
| 05 | Pairing code | 12 | 1:12 |
| 06 | Hub device registration | 16 | 1:28 |
| 07 | Hub onboarding | 16 | 1:44 |
| 08 | Hub dashboard | 14 | 1:58 |
| 09 | App Store browse | 18 | 2:16 |
| 10 | App detail + install | 20 | 2:36 |
| 11 | App running | 12 | 2:48 |
| 12 | Portal fleet view | 12 | 3:00 |
| 13 | Outro | 5 | 3:05 |

## Production notes

- **Screens marked NEEDS REVIEW** in shots.json require live state (a paired device, an installed app) that can't be faked from an empty dev environment. Everything else can be captured against a local dev stack (`pnpm dev` in each repo) with seeded/demo data.
- **Transitions:** default is a 12-frame cross-dissolve with 4% scale settle. Between Portal↔Hub context switches (scenes 05→06 and 11→12), use a horizontal wipe with the teal rule as the wipe edge to signal "different machine."
- **Browser chrome:** wrap Portal and live-app shots in a minimal dark browser frame showing the real URL; Hub shots can be full-bleed (it's an appliance UI / Tauri desktop app).
- **Lifecycle strip (Scene 10):** the canonical status values come from `CI-Hub/packages/common/src/schemas/sse.ts` — use `installing`, `starting`, `running` only; don't invent states.
- **Accessibility:** captions stay ≥48px Montserrat SemiBold, bottom-third, 80% max width, on a 40% navy scrim.
