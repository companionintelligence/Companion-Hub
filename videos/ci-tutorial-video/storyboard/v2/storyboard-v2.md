# Companion Intelligence — Tutorial Video, Storyboard v2

> Assembled 2026-06-10 from six revised section storyboards (c1–c6).
> Companion files: `scenes-v2.json` (render plan), `shots-v2.json` (capture manifest),
> `narration-v2.md` (TTS feed for `scripts/gen-narration.sh`), `marketing-v2.md` (distribution pack).

---

## 0. Editorial summary (what the merge changed)

1. **Pacing.** Sections summed to 242s (4:02) — over the 3:30–4:00 target. Trimmed 6s:
   - `c2-portal-name-device` 9 → 8s (narration was 1.9 w/s — slack).
   - `c3-hub-claim` 14 → 13s; dropped the "— owned, not rented —" aside (roast dedup + pace).
   - `c3-hub-dashboard` 12 → 10s; dropped "Go ahead — point." with the demoted pointing-hand gag.
   - `c3-hub-controls` 14 → 13s; narration tightened to 2.5 w/s.
   - `c4-store-lifecycle` 12 → 11s; dropped "No signup, no card on file, no monthly anything" (the
     subscription roast now belongs to c6's tally alone).
   - **New total: 236s (3:56) landscape.** Average narration rate ≈ 2.4 w/s (559 words / 236s).
2. **Joke dedup.** The coral `$9.99/mo` price tag appeared in four chapters (c2 soap-bubble, c4 peel-off,
   c5 pocket-cloud, c6 unhook). It now appears **exactly once**: planted on the dashboard corner in
   `c6-close-fleet`, paid off in `c6-close-tally`. Coral #F47C6C is used nowhere else in the video, which
   makes the payoff land harder. Each chapter keeps **one** roast, each with a different target:
   - c1: the cloud itself (ToS-streamer deflate) · c2: none — product charm instead (stenographer slug)
   - c3: SaaS support (ticket stub, "EST. WAIT: 6 DAYS") · c4: data collection (searching asterisk)
   - c5: none — anthropomorphic warmth (CPU exhale) · c6: subscriptions (the price-tag unhook)
3. **One gag per chapter.** Per chapter, the strongest gag stays in the cut; all others are demoted to
   **Appendix A** as production options. Motion *polish* (subway-stop progress line, mint pulse, copy-check
   micro-interaction, wifi→5G flip) stays in motion notes — polish is not a booked laugh.
4. **Caption dedup.** `c2-portal-window-shop` caption changed to "Browse first. Sign in later."
   (was a second buying joke); `c4-store-install` caption changed to "One dialog. Secrets handle
   themselves." (was a third no-card/no-subscription joke).
5. **Shot dedup.** c5's `hub-home-mobile` merged into `hub-home-dashboard-mobile` (canonical: v1 base id +
   `-mobile`); c5's `portal-home-mobile` and `app-immich-live-mobile` merged with c2/c4's entries (state
   descriptions union'd). Final manifest: **34 shots — 18 reuse v1 captures, 16 new** (12 mobile-viewport,
   4 new desktop states).
6. **Continuity.** One user, one journey, one slug set: device **Living Room Server**, org placeholder
   **acme** → `hub-living-room-server-acme.ci.computer` / `immich-living-room-server-acme.ci.computer`
   everywhere (c4 had "home", c5 had "myorg" — fixed). Substitute the real QA org slug uniformly at
   capture time. Chapter seams are written as handoffs (see transition notes at each chapter head).
7. **Both formats.** Landscape (1920×1080) and portrait (1080×1920) share one master timeline (236s);
   portrait re-stages per the per-beat portrait notes. The 60s portrait teaser is a separate cut
   (see `marketing-v2.md`).

---

## 1. Timing table — both formats

Durations are identical across formats (one master timeline; portrait restages composition, not timing).

| # | Scene id | Chapter | Landscape | Portrait | In → Out (cum.) |
|---|----------|---------|-----------|----------|------------------|
| 1 | c1-open-brand-intro | c1-open | 7s | 7s | 0:00 → 0:07 |
| 2 | c1-open-platform-map | c1-open | 9s | 9s | 0:07 → 0:16 |
| 3 | c1-open-cloud-joke | c1-open | 6s | 6s | 0:16 → 0:22 |
| 4 | c2-portal-signup | c2-portal | 9s | 9s | 0:22 → 0:31 |
| 5 | c2-portal-window-shop | c2-portal | 9s | 9s | 0:31 → 0:40 |
| 6 | c2-portal-workspace | c2-portal | 10s | 10s | 0:40 → 0:50 |
| 7 | c2-portal-name-device | c2-portal | 8s | 8s | 0:50 → 0:58 |
| 8 | c2-portal-pairing-code | c2-portal | 11s | 11s | 0:58 → 1:09 |
| 9 | c3-hub-claim | c3-hub | 13s | 13s | 1:09 → 1:22 |
| 10 | c3-hub-onboarding | c3-hub | 12s | 12s | 1:22 → 1:34 |
| 11 | c3-hub-dashboard | c3-hub | 10s | 10s | 1:34 → 1:44 |
| 12 | c3-hub-controls | c3-hub | 13s | 13s | 1:44 → 1:57 |
| 13 | c4-store-catalog | c4-store | 12s | 12s | 1:57 → 2:09 |
| 14 | c4-store-exclusives | c4-store | 10s | 10s | 2:09 → 2:19 |
| 15 | c4-store-privacy | c4-store | 10s | 10s | 2:19 → 2:29 |
| 16 | c4-store-install | c4-store | 8s | 8s | 2:29 → 2:37 |
| 17 | c4-store-lifecycle | c4-store | 11s | 11s | 2:37 → 2:48 |
| 18 | c4-store-live | c4-store | 10s | 10s | 2:48 → 2:58 |
| 19 | c5-mobile-portal-pocket | c5-mobile | 12s | 12s | 2:58 → 3:10 |
| 20 | c5-mobile-hub-vitals | c5-mobile | 10s | 10s | 3:10 → 3:20 |
| 21 | c5-mobile-open-anywhere | c5-mobile | 12s | 12s | 3:20 → 3:32 |
| 22 | c6-close-fleet | c6-close | 10s | 10s | 3:32 → 3:42 |
| 23 | c6-close-tally | c6-close | 8s | 8s | 3:42 → 3:50 |
| 24 | c6-close-outro | c6-close | 6s | 6s | 3:50 → 3:56 |
| | **Total** | | **236s (3:56)** | **236s (3:56)** | |

Chapter subtotals: c1 22s · c2 47s · c3 48s · c4 61s · c5 34s · c6 24s.

---

## Chapter 1 — Cold open + platform map (0:00–0:22)

The brand thesis in 22 seconds: AI at home, one Hub, and exactly one cloud joke to set the tone.
**Chapter gag (kept): the deflating ToS cloud.** The intro upload-arrow and the porch-light delayed-blink
punchline are demoted to Appendix A — but the roofline + porch light still get *built* in the map beat,
played straight, because the cloud joke needs the porch light as its responder.

**Transition out → c2:** standard 15-frame fade from the settled diagram; the c2 browser frame rises
from roughly the Portal card's screen position — the diagram node becomes the product.

### 1. c1-open-brand-intro — intro, 7s (0:00–0:07)
- **Caption:** Your data. Your hardware. Your AI.
- **Narration:** This is Companion Intelligence — AI that lives in your home, with data that never has to leave it.
- **Gag:** none (upload-arrow hesitation demoted → Appendix A).
- **Visual/Motion:** Modified IntroScene (`src/scenes/IntroScene.tsx`) as built: orb glow blooms 0.2→0.6
  opacity over 60f; CIBanner (single combined banner SVG from `src/components/CILogo.tsx` — no separate
  wordmark, no type-on) fades in and rises translateY 30→0 from f18; tagline rises beneath from f40,
  settles ~f70. GradientBackground flat near-black teal-navy (#041620 per theme.ts — never pure black)
  with radial depth lift and drifting mint/cyan glows. Montserrat throughout; calm pace, no camera move.
- **Portrait:** Logo mark above wordmark in the upper two-thirds of 1080×1920. ASSET DECISION REQUIRED:
  `public/logos` has only `2024_CI__LogoMark_Color_med.svg` plus two combined banner SVGs — either crop
  the wordmark out of `2024_CI__Logo_Banner_Color_small.svg` or set it as Montserrat ExtraLight text
  under the mark; flag for the responsive-component task. Tagline at the lower-third scrim.

### 2. c1-open-platform-map — diagram, 9s (0:07–0:16)
- **Caption:** One Hub. Everything under your roof.
- **Narration:** At the center is the Hub: a small computer in your home. Your apps, your AI, your memory — all under one roof.
- **Gag:** none in v2 cut (delayed porch-light blink demoted → Appendix A). Roofline + porch light are
  retained as **set dressing**: roofline draws over the Hub card after it settles, porch light turns on
  cleanly with it — no comic delay. It must exist here so the c1-open-cloud-joke payoff has a responder.
- **Visual/Motion:** Modified PlatformDiagram (`src/components/PlatformDiagram.tsx`). As built: five
  label+sub TEXT CARDS (no icons) scale-pop in array order — Portal ('Cloud control plane'), Marketplace
  ('App catalog'), Hub ('App runtime — your appliance', accent card with pulsing orb), Server ('Private
  memory brain'), 'Clients & devices / Capture · XR · wearables' — i*5f stagger. Each edge draws ONCE,
  outer node toward the Hub, strokeDashoffset, i*6f stagger from f14 (data-flows-home texture; not synced
  to narration). ONE-LINE CHANGE: give the Hub stagger index 0 (or reorder NODES) so it lands first to
  match narration. NEW WORK: roofline draw + porch light. 'All under one roof' is true at the appliance
  level (Hub installs CI-Server alongside marketplace apps), so Server's sub-label stays as built.
- **Portrait:** Vertical re-flow: Portal top, Hub centered (already the 460px accent card ≈1.2× the 380px
  standard; scale to ~1.4× if hierarchy needs it), Server + Marketplace flanking below, Clients card along
  the bottom. All remain text cards. Edges draw along the vertical axis, still toward the Hub. Labels ≥28px;
  sub-labels may truncate ('Capture · XR · wearables' → 'Capture · XR'). Roofline + porch light above the
  Hub card on the vertical centerline.

### 3. c1-open-cloud-joke — diagram, 6s (0:16–0:22) — CHAPTER GAG
- **Caption:** the cloud (n.) — somebody else's computer. / the Hub (n.) — yours.
- **Narration:** We read the fine print, so you don't have to. This one is yours.
- **Gag (KEPT):** A generic gray cloud puff drifts in dragging a small "We've updated our Terms of
  Service" banner behind it like a parade streamer, then deflates unprompted — streamer crumpling with
  it — as the Hub's porch light glows a touch brighter in answer.
- **Visual/Motion:** Camera holds on the completed diagram. Gray cloud enters from the frame edge
  opposite the Portal card (never read as our Portal); deflate runs ~20f and is the beat's only visual
  joke — NO dictionary stamp on screen; the caption alone carries the definition, rendered as two
  dictionary entries with the second ('the Hub (n.) — yours.') in accent teal #82FCFC. ONE-LINE PROP on
  PlatformDiagram: Portal's sub-label crossfades 'Cloud control plane' → 'Control plane' for this beat
  only, so the word 'cloud' is not on screen while clouds are being mocked; Portal stays fully lit. Exit
  on the timeline's standard 15-frame fade (timeline.tsx ships fade() only — the teal-rule wipe motif is
  logged as new TransitionSeries work in Production notes, not this beat's dependency).
- **Portrait:** Cloud + ToS streamer enter from the top, clearly above/separate from the Portal card.
  Deflate-and-glow exchange on the vertical centerline so cloud and porch light are both visible without
  a camera move. Dual dictionary caption stacks as two lines in the lower-third scrim, second line teal,
  ≥32px.

---

## Chapter 2 — Portal: account, workspace, devices, pairing (0:22–1:09)

The cloud plane that earns its keep by *not* keeping anything. Account → public store browse → workspace →
name a device → pairing code. **Chapter gag (kept): the stenographer slug** — product-true, supported by
`generateSlugPreview()`, repeated nowhere else. Padlock nod, price-tag soap bubble, and the 0→1 odometer
are demoted; the copy-check micro-interaction stays in motion notes because it is the product's real
behavior, played sincerely.

**Transition in:** fade from the diagram; browser frame slides up. **Transition out → c3:** the pairing
beat ends on a push-in to the code card and starts the teal-rule horizontal wipe — the video's
machine-switch language (NEW build, see Production notes).

### 4. c2-portal-signup — screen, 9s (0:22–0:31)
- **Screens:** `portal-signup` (browser, hub.ci.computer/signup) · `portal-signup-mobile` (phone)
- **Caption:** Sign up free. Your data stays yours.
- **Narration:** Start at hub dot ci dot computer and create a free account. The Portal manages your devices and apps — never your data.
- **Gag:** none (padlock click-and-nod demoted → Appendix A; no padlock element exists on the page —
  it was a Remotion overlay anyway).
- **Visual/Motion:** Dark browser frame slides up showing hub.ci.computer/signup. Slow push-in 1.0→1.05
  on the form. Simulated cursor fills email then password. Cut on a soft submit ripple; 12f cross-dissolve
  out. All caption/overlay text Montserrat per style.MD.
- **Portrait:** Lead with the phone-framed mobile signup (`portal-signup-mobile`) centered ~85% width;
  desktop frame omitted. Caption in the upper third above the phone. Same cursor fill, vertically biased
  push-in.

### 5. c2-portal-window-shop — screen, 9s (0:31–0:40)
- **Screens:** `portal-store-public` (browser, hub.ci.computer/store) · `portal-store-public-mobile` (phone)
- **Caption:** Browse first. Sign in later. *(changed from "Browse before you buy. There's nothing to
  buy." — buying-joke dedup; c4's catalog stat and c6's tally own the money jokes)*
- **Narration:** Before you sign in to anything, browse the public App Store — two hundred apps, every one of them yours to keep.
- **Gag:** none (price-tag soap bubble demoted → Appendix A; the tag now lives only in c6).
- **Visual/Motion:** No login — URL bar reads hub.ci.computer/store to make the 'public' point silently.
  Open at the top of the default All Apps view ('Browse every app in the Companion App Store' heading,
  alphabetical grid — no Featured row at this URL), hold a beat, then slow vertical drift to the H–J
  alphabetical band where Home Assistant (row ~16, col 1), Immich (row ~17, col 4), and Jellyfin
  (row ~18, col 1) share one desktop frame. Drift under 40px/s so logos stay readable.
- **Portrait:** Phone-framed mobile store fills the frame. In the 1-column list Home Assistant is
  ~card 61, so open on the top-of-page take, then dissolve (don't scroll sixty cards) to the H–J-region
  take so the flagship cards pass through center-frame.

### 6. c2-portal-workspace — screen, 10s (0:40–0:50)
- **Screens:** `portal-home` (browser, hub.ci.computer/home) · `portal-home-mobile` (phone)
- **Caption:** Mission control, minus the mission creep.
- **Narration:** Once you're in, this is your workspace. Every app you've launched on the left, every device you own on the right. One quiet dashboard.
- **Gag:** none (motion polish only, as authored).
- **Visual/Motion:** Open wide on desktop /home: WorkspaceHeader, AppLauncherGrid, DevicesSidebar. App
  tiles snap into the grid one by one with soft ticks — polish, not a booked laugh. Highlight ring sweeps
  the grid, settles on the sidebar. At the 6s mark a phone frame slides in from the right at ~60% height
  showing `portal-home-mobile` — hold the split to sell 'same workspace, any screen'. Caption fallback if
  the voice-read test stumbles: 'Every app you've launched. Every device you own. That's the whole
  dashboard.'
- **Portrait:** Inverted: phone frame dominant, full-height; desktop browser appears as a scaled wide card
  tucked behind/above at ~70% width so the sidebar layout still reads. Highlight ring runs inside the
  phone frame.

### 7. c2-portal-name-device — screen, 8s (0:50–0:58) — CHAPTER GAG *(trimmed from 9s)*
- **Screens:** `portal-add-device-dialog` (browser, hub.ci.computer/home)
- **Caption:** Name it like you'll keep it. You will.
- **Narration:** To claim a machine, add a device and give it a name. Living Room Server. That'll do.
- **Gag (KEPT):** The slug preview types out 'Slug: living-room-server' in its code chip half a beat
  behind the name field, like a diligent stenographer keeping up. The lag itself reads on screen — no
  caption needed. Fully supported by the product's `generateSlugPreview()`.
- **Visual/Motion:** From /home, background dims 40%; 'Name your device' dialog scales 0.96→1.0. Simulated
  cursor clicks the field; 'Living Room Server' types over ~2s at human cadence with one believable pause —
  it exactly matches the field's real placeholder ('e.g. Living Room Server'). CTA click leads directly
  into the pairing beat.
- **Portrait:** Crop to the centered dialog from the desktop capture, scale to ~90% portrait width — the
  dialog card is naturally tall and reads native in portrait. Dimmed workspace visible at the edges;
  caption below the dialog.

### 8. c2-portal-pairing-code — screen, 11s (0:58–1:09)
- **Screens:** `portal-pairing-code-dialog` (browser) · `portal-pairing-code-dialog-mobile` (phone)
- **Caption:** Six characters between you and ownership.
- **Narration:** The Portal answers with a pairing code. No verification email, no expiring link — six characters is the whole ceremony. Carry it to your Hub, and the machine becomes yours.
- **Gag:** none (0→1 odometer device count demoted → Appendix A).
- **Visual/Motion:** Cross-dissolve from the name dialog to the 'Device Pairing Code' dialog. The real
  dialog is content-tall: Shield icon header, 'Your Pairing Code' label, primary-bordered gradient code
  card (NOT teal — reads as a faint light border in dark mode; any teal glow is a deliberate Remotion
  overlay), security-warning box, and 'Open in Companion Hub' / 'I've Saved My Code' buttons. Code glyphs
  land sequentially over ~1.5s with typewriter weight; gentle glow pulse on the code card. Copy
  micro-interaction at the 6s mark exactly as the product does it: icon button flips Copy → green Check,
  and a separate '✓ Copied to clipboard!' line fades in below the code row — no 'Copied' label on the
  button itself (sincere craft, not a gag). Phone frame with the mobile dialog slides in beside it — the
  code exists on both screens. End on a slow push cropping tight to the code card; begin the teal-rule
  horizontal wipe that hands off to the Hub chapter.
- **Portrait:** Phone-framed mobile dialog is the hero, near full-height. Final push-in crops to the code
  card itself — past the Shield header, security note, and buttons — so the code crop fills the width.
  Desktop dialog appears briefly as a scaled card behind, then recedes. Teal-rule wipe exits vertically
  (bottom → top) in portrait.

---

## Chapter 3 — Hub: claim, onboard, dashboard, controls (1:09–1:57)

Same code, new machine: the wipe lands us on the Hub's registration page, and the chapter runs claim →
first-boot wizard → dashboard → settings/monitor. **Chapter gag (kept): the support-ticket stub**
("EST. WAIT: 6 DAYS") — the chapter's roast, aimed at SaaS support rather than clouds or subscriptions.
EKG blip, button glint, and the pointing-hand audit demoted (the section itself flagged the glint as
cuttable); the subway-stop progress line stays as motion texture.

**Transition in:** teal-rule horizontal wipe (machine-switch language). **Transition out → c4:** the
controls beat ends on the resource-monitor table; a simulated click on the Store nav item carries us into
the catalog — same machine, no wipe needed.

### 9. c3-hub-claim — screen, 13s (1:09–1:22) *(trimmed from 14s; "— owned, not rented —" cut)*
- **Screens:** `hub-device-registration-empty`, `hub-device-registration-provisioning`,
  `hub-device-registration-complete` (browser) · `hub-device-registration-mobile-code`,
  `hub-device-registration-mobile-provisioning` (phone)
- **Caption:** Six characters. Then it's alive.
- **Narration:** Over on the Hub, type in the code and watch it work — provisioning your domain, setting up your Hub, done. Your machine now has its own secure address on the internet.
- **Gag:** none (EKG heartbeat blip demoted → Appendix A; first to reinstate if runtime allows — it pays
  off this caption).
- **Visual/Motion:** Teal horizontal wipe in. `hub-device-registration-empty`: the 6 mono characters type
  in one by one with soft keystroke micro-scales on the pairing-code input (Step 2 panel; page auto-focuses
  it). Cross-dissolve to provisioning: status card phases advance as the real strings — 'Provisioning your
  domain' then 'Setting up your Hub' — rendered as three small stops on a thin overlay progress line, a
  teal dot sliding between them (texture, not a joke). The live page replaces the form with the status
  card in pending phases, so the dissolve is a state change, not a scroll. Hard cut on a beat to the
  complete state; 6-frame hold before transition out.
- **Portrait:** Phone frame leads; the two mobile captures play in sequence (the live page never renders
  input + status card together; the code clears on success): `…-mobile-code` full-height as the characters
  type above the Register button; teal cross-wipe to `…-mobile-provisioning` showing the status card alone
  on 'Setting up your Hub', the three-stop progress line running vertically beside it. End on a 1.5s scaled
  browser-frame insert of the complete state.

### 10. c3-hub-onboarding — screen, 12s (1:22–1:34)
- **Screens:** `hub-onboarding-form`, `hub-onboarding-installing` (browser)
- **Caption:** Install & Finish. The button means it.
- **Narration:** First boot is one guided pass: pick local AI models, choose remote access, check a few recommended apps, and press Install and Finish. The Hub handles the rest. *(dropped "No welcome-email series." — second roast in chapter)*
- **Gag:** none (Install & Finish glint demoted → Appendix A — the section itself said to cut it if it
  reads as ambient polish; we're cutting it).
- **Visual/Motion:** Slow vertical pan down the 'Set Up Your Hub' wizard: hold briefly on the local AI
  models / Ollama step, keep moving past the remote-access step (its visible heading is 'Set Up Private
  VPN' — don't hold long enough for a framing mismatch), then settle on Step 4 'Recommended Apps'. Pinned
  apps are already selected on the real page; animate the circular select indicators on two additional
  app cards ticking on in sequence on a 6-frame grid. Highlight ring lands on the sticky footer 'Install
  & Finish' (data-testid `finish-setup-btn`); simulated click depresses it; cut to
  `hub-onboarding-installing` with the InstallStep progress list animating two rows.
- **Portrait:** The wizard is desktop-first: browser frame scaled to ~94% portrait width, vertical pan
  inside it, sticky Install & Finish footer pinned at the crop's bottom edge throughout. Crop tighter
  (~1.3×) on the Recommended Apps grid for the select-indicator ticks.

### 11. c3-hub-dashboard — screen, 10s (1:34–1:44) *(trimmed from 12s; "Go ahead — point." cut with its gag)*
- **Screens:** `hub-home-dashboard` (browser, hub-living-room-server-acme.ci.computer/home) ·
  `hub-home-dashboard-mobile` (phone, same URL)
- **Caption:** Numbers you can point at.
- **Narration:** And this is home. Disk, CPU, memory — real numbers from a box you can physically point at. Same view from your phone.
- **Gag:** none (pointing-hand audit demoted → Appendix A).
- **Visual/Motion:** `hub-home-dashboard` enters with the three stat cards' (DISK SPACE, CPU LOAD, MEMORY
  USED — rendered uppercase) progress bars filling and numbers counting up, staggered 6f apart. On 'Same
  view from your phone', the phone frame (`hub-home-dashboard-mobile`) slides in from the right at ~38%
  height, slightly overlapping the browser frame; the mobile layout keeps the same 3-across stat-card row
  (fixed grid), which helps the side-by-side read as one machine.
- **Portrait:** Inverted: phone frame leads full-height. At 390px the three cards keep their real
  single-row 3-across layout (grid-cols-3, no responsive breakpoint — they do not stack), counting up side
  by side above the installed-apps list. Desktop browser slides in scaled (~70% width) behind/below the
  phone for the final 2s — same numbers, two screens, one machine.

### 12. c3-hub-controls — screen, 13s (1:44–1:57) — CHAPTER GAG *(trimmed from 14s)*
- **Screens:** `hub-settings-overview` (browser, …/settings) · `hub-resource-monitor` (browser, …/resource-monitor)
- **Caption:** Every dial. No tickets.
- **Narration:** Want the dials? They're all here — security, network, app stores, AI, logs. The resource monitor charts every app's CPU in real time. Every dial is yours — and reading your own logs costs nothing.
- **Gag (KEPT):** A small perforated support-ticket stub — torn perforation edge plus two lines of mono
  microtext, 'SUPPORT TICKET' / 'EST. WAIT: 6 DAYS' — detaches from the corner of the settings frame,
  drifts down-right like a falling leaf, and dissolves before it leaves frame. Fires on 'Every dial is
  yours', while the caption 'No tickets' is on screen.
- **Visual/Motion:** `hub-settings-overview`: tab row (Settings, Security, App Stores, Network, AI, System,
  Logs) gets a quick left-to-right highlight sweep, one tab per ~5f, syncing roughly with the narration
  list; hold on the Settings tab with the public hub hostname field (hub-living-room-server-acme.ci.computer)
  visible. Ticket-stub gag fires on 'Every dial is yours'. Cross-dissolve to `hub-resource-monitor`:
  per-app CPU polylines draw on like pen strokes in their series colors, legend chips pop with soft ticks,
  then a short pan down to the app table with green 'Responsive' cells, landing as 'costs nothing'
  resolves. Exit: simulated click on the Store nav → c4.
- **Portrait:** Sequence rather than stack: settings frame first at ~94% width with the tab sweep cropped
  tight on the tab row, then the resource monitor. The CPU chart is wide (960×320): crop to the left
  two-thirds and pan right as lines draw; the table shows as a 2-column crop (App, CPU). Ticket stub falls
  vertically past the frame edge, microtext readable at phone scale.

---

## Chapter 4 — App Store + Marketplace: catalog to running app (1:57–2:58)

The longest chapter and the spine of the demo: catalog scale → CI exclusives → the privacy card → install
dialog → lifecycle → the live app on your own domain. **Chapter gag (kept): the searching asterisk** on
'No data collected' — privacy roast, the chapter's one booked laugh. Price-tag peel, 'Also available
on: —', '(We don't know them either.)', and the padlock bounce demoted. The mint running-pulse and the
stage-strip bow stay as motion polish (explicitly not jokes; no confetti anywhere).

**Transition in:** Hub nav click from the resource monitor. **Transition out → c5:** from the live Immich
timeline, dissolve to the phone-pocket stage — "everything you just built fits in your pocket."

### 13. c4-store-catalog — feature, 12s (1:57–2:09)
- **Screens:** `hub-store-grid`, `hub-store-featured` (browser, https://hub-living-room-server-acme.ci.computer/store) ·
  `hub-store-featured-mobile` (phone)
- **Caption:** 200 apps. 0 subscriptions.
- **Narration:** This is the App Store, fed by the open Marketplace — two hundred apps and counting. Photos, media, home automation, passwords — everything you've been renting, ready to own.
- **Gag:** none (price-tag peel demoted → Appendix A; the tag is c6's now).
- **Visual/Motion:** Open on hub /store in a browser frame: the real index view (alphabetical by URN,
  activepieces / adguardhome-sync / …, 24-per-page infinite scroll) with a slow lateral drift ~4s to convey
  scale. Cut to the Featured category view (16 apps — includes all 8 flagships) for the highlight-ring hop:
  Immich → Jellyfin → Home Assistant → Nextcloud → n8n → Open WebUI → Vaultwarden → Pi-hole (~0.8s each,
  eased). Top-left, a quiet pipeline chip animates in: 'Open Marketplace → 200 apps → your Hub', one pulse
  along the arrow when narration credits the Marketplace — this chip and the narration are the only two
  Marketplace credits; the caption stays out of it. App count ticks 195→200 odometer-style in the caption
  corner on entry (overlay only — the store UI shows no count; re-verify against the live /api search total
  at capture time). Category selection lives in Zustand, not the URL — set Featured in UI state before
  capture.
- **Portrait:** Mobile-led: `hub-store-featured-mobile` fills the center column with a vertical scroll
  drift (Featured puts Home Assistant, Immich, Jellyfin near the top alphabetically — flagships above the
  fold). Desktop frame slides in scaled ~55% behind/above for 3s as a 'same store, every screen' stack,
  then exits. Pipeline chip rides the top third; caption above the phone on the navy scrim.

### 14. c4-store-exclusives — screen, 10s (2:09–2:19)
- **Screens:** `hub-store-ci-category` (browser, …/store)
- **Caption:** The Companion exclusives shelf. Only here — still yours.
- **Narration:** Or head straight for the Companion exclusives — Companion Earth, Photo Time Machine, Just In Case, Spellbook — apps you won't find on anyone else's shelf.
- **Gag:** none ('Also available on: —' spec line demoted → Appendix A).
- **Visual/Motion:** Straight cut to the store pre-filtered to the companion-intelligence category (13 apps
  return); grid settles with a card shuffle-and-settle, 3f stagger per card. Do NOT animate a sidebar
  category click — companion-intelligence has no sidebar entry (`iconForCategory` omits it); set the filter
  in Zustand before capture. Highlight ring passes over Companion Earth, Photo Time Machine, Just In Case,
  then Spellbook as each is named. Polish: a quiet teal sheen sweeps once across the exclusives row, like
  light moving along a shelf. Hold 1.5s on the filtered grid before exit.
- **Portrait:** Crop the desktop capture to a two-column slice and pan vertically down the cards; same
  settle stagger. Caption below center.

### 15. c4-store-privacy — screen, 10s (2:19–2:29) — CHAPTER GAG
- **Screens:** `hub-app-details-immich` (browser, …/store)
- **Caption:** Data Collection: 'No data collected.' That's the whole list.
- **Narration:** Every app page carries an App Privacy card. Here's Immich's — under Data Collection, the entire list: no data collected. It's a quick read.
- **Gag (KEPT):** A footnote asterisk fades in beside 'No data collected' — oversized to ~1.4× footnote
  scale so it reads at video size — drifts to the bottom of the card looking for fine print with two small
  left-right nudges (4–6f each), holds one beat of stillness, finds none, and politely fades out.
- **Visual/Motion:** Land on the Immich details page (logo, 'About this app' description panel,
  right-column Information panel). After 2s, push in 1.0→1.18 on the App Privacy card while the rest of
  the page dims 30%. Hold the card 3 full seconds in silence after the narration line lands — let the card
  do the joke. The asterisk's stillness beat before its fade is where the laugh lives; no other UI motion
  during the hold.
- **Portrait:** The App Privacy card is nearly square — center it full-width in the portrait safe column
  with the rest of the details page blurred behind. Identical push-in; caption under the card.

### 16. c4-store-install — screen, 8s (2:29–2:37)
- **Screens:** `hub-install-dialog-immich` (browser, …/store)
- **Caption:** One dialog. Secrets handle themselves. *(changed — was a third no-card/no-subscription joke)*
- **Narration:** Hit install. Secrets generate themselves — you never see them. Upload location, pre-filled. One click to your own photo server.
- **Gag:** none ('(We don't know them either.)' annotation demoted → Appendix A).
- **Visual/Motion:** Install button gets a highlight ring and a click; 'Install Immich' dialog springs open
  (scale 0.96→1.0 over 8f, soft overshoot). The dialog shows NO secret fields — Immich's three secrets are
  type 'random' and filtered out of the form entirely; do not animate secret characters filling in.
  Instead, the pre-filled Upload Location field ('/nfs/cihub/immich') gets a brief underline pulse as
  narration mentions it. Cursor moves to submit and clicks on the final word of narration — the click is
  the transition into the lifecycle beat.
- **Portrait:** The dialog is naturally narrow — near full-width in the portrait column, page dimmed
  behind; no desktop frame needed. Submit click stays the hard cut to the lifecycle beat.

### 17. c4-store-lifecycle — feature, 11s (2:37–2:48) *(trimmed from 12s; subscription line cut)*
- **Screens:** `hub-app-installing-immich`, `hub-app-install-progress-immich`, `hub-app-running-immich`
  (browser, …/apps)
- **Caption:** installing → running
- **Narration:** Then the Hub does the work — preparing, downloading, setting up — and running. That green badge means Immich is live, on your hardware.
- **Gag:** none in the booked sense — the single mint pulse stays as **motion polish**: the instant the
  badge flips to 'running', one soft ring ripple in #58EBBF radiates from the green dot, then stillness.
  No confetti.
- **Visual/Motion:** Cut to /apps/:storeId/immich. Real UI behavior: the status badge is a gray-400 dot
  labeled 'installing' for the whole install (never amber — amber is install_failed), while the
  'Installing X%' button beneath shows a live percentage with a stage line ticking through the real
  strings in sync with narration: 'Preparing' (<20%), 'Downloading' (<40%), 'Setting up' (<70%),
  'Starting' (<90%), 'Almost ready' (90%+). A small overlay strip along the bottom mirrors these stage
  strings, each node lighting as reached; the final node holds its glow a half-beat longer, like a small
  bow. Then the badge flips directly to 'running' — pulsing green-500 dot — with the mint pulse. Open and
  Stop buttons fade in under the green badge (Restart lives in the actions dropdown, not as a button).
  A fresh install never shows a 'starting' badge — that state only appears on manual stop/start; do not
  depict it.
- **Portrait:** Stack vertically: status badge large at center, install-progress button + stage line
  beneath, stage strip below, action buttons last — crop away page chrome. The mint pulse reads full-frame
  in both formats.

### 18. c4-store-live — screen, 10s (2:48–2:58)
- **Screens:** `app-immich-live` (browser, https://immich-living-room-server-acme.ci.computer) ·
  `app-immich-live-mobile` (phone, same URL)
- **Caption:** Your photos. Your domain. The URL bar is the receipt.
- **Narration:** And here it is — your full photo timeline, served from your own machine, on your own domain. Read the URL bar.
- **Gag:** none (URL-bar padlock bounce demoted → Appendix A).
- **Visual/Motion:** Click 'Open' carries over from the previous beat; browser frame slides in with the
  URL typing on character by character: immich-living-room-server-acme.ci.computer — the URL animation IS
  the moment, give it a full 2s with a soft teal underline sweep beneath the address bar. The caption
  lands the receipt line; narration only sets it up — do not repeat 'receipt' in VO. Then slow push-in
  (1.0→1.06) on the populated Immich photo timeline. Hold 2s, no other motion.
- **Portrait:** Phone frame with `app-immich-live-mobile` dominant, full-height. Mobile browsers hide
  URLs, so render a custom URL chip pinned above the phone frame with the same type-on animation — the
  proof has to survive the portrait crop. Desktop frame not needed in this orientation.

---

## Chapter 5 — Mobile: the whole loop from your phone (2:58–3:32)

Everything from chapters 2–4, revisited at thumb scale: Portal in your pocket, the Hub's vitals, and your
app on your own domain from any network. **Chapter gag (kept): the CPU exhale** — the server relaxing
because you checked in. The pocket cloud (price-tag dedup), the pin-hop bench, and the background-cloud
callback are demoted; the wifi→5G status-bar flip stays as ambient texture for rewatchers.

**Transition in:** dissolve from the Immich timeline to the gradient stage; the phone slides up from a
pocket. **Transition out → c6:** teal-rule wipe back to the Portal — "Back in the Portal."

### 19. c5-mobile-portal-pocket — screen, 12s (2:58–3:10)
- **Screens:** `portal-home-mobile` (phone, hub.ci.computer/home)
- **Caption:** Every device you own. One pocket.
- **Narration:** Everything you just built fits in your pocket. Open the Portal on your phone — every device, every app, one tap away. No app store between you and what you own.
- **Gag:** none (priced pocket-cloud demoted → Appendix A).
- **Visual/Motion:** Teal-navy gradient stage (#041620 ground, #244859 lift — never neutral black). Phone
  frame slides up from the bottom edge (as if drawn from a pocket — a single subtle stitched-line graphic
  at the bottom sells it), settles slightly right of center with a soft teal rim glow. Portal /home mobile
  layout scrolls slowly upward inside the frame: WorkspaceHeader, then AppLauncherGrid, then the devices
  list (DevicesSidebar genuinely inlines below the grid on mobile — this scroll order is exactly what the
  UI does). Caption sits in the left negative space.
- **Portrait:** Phone frame near-fullscreen (~85% height, centered); the pocket slide-up reads even better
  since the frame matches the viewer's own phone. Caption in the top third on a 40% navy scrim.

### 20. c5-mobile-hub-vitals — screen, 10s (3:10–3:20) — CHAPTER GAG
- **Screens:** `hub-home-dashboard-mobile` (phone) *(shot id canonicalized — was "hub-home-mobile" in the
  section draft)*
- **Caption:** Your server's vitals, live on your phone
- **Narration:** Check on the Hub itself from anywhere. Disk, CPU, memory, at a glance. It's doing fine. It usually is.
- **Gag (KEPT):** The CPU load bar visibly exhales — it eases down 2–3% right as the narrator says "It's
  doing fine," like the server relaxing because you checked in. Pin it to cubic-bezier(0.4,0,0.2,1) so it
  reads as a breath, not a data glitch. Nothing follows it — no third sentence, no visual rimshot; the
  understatement is the beat.
- **Visual/Motion:** Cross-dissolve keeps the phone in the same stage position on the gradient stage.
  Inside the frame the Hub /home stat cards — 'Disk space', 'CPU load', 'Memory used', rendered
  three-across in the dashboard's fixed three-column grid (they do NOT stack at mobile width) — animate
  bars and count-up numbers on entry, then the installed-apps list peeks in from below. Slow 1.0→1.04
  push-in over the full beat; hold the frame steady during the exhale so the 2–3% drop reads.
- **Portrait:** Phone frame near-fullscreen; the three-across cards are compact at 390px, so let the
  count-up numbers carry the beat and keep the camera still through the exhale. Caption in the bottom
  third under the frame's chin.

### 21. c5-mobile-open-anywhere — screen, 12s (3:20–3:32)
- **Screens:** `hub-app-running-immich-mobile` (phone) · `app-immich-live-mobile`
  (phone, immich-living-room-server-acme.ci.computer)
- **Caption:** Any couch. Any café. Same URL.
- **Narration:** And your apps open right here too. Tap Open, and your photo library loads from your own domain — home wifi, coffee shop, anywhere. The address doesn't change because you moved.
- **Gag:** none (pin-hop bench + background-cloud callback demoted → Appendix A). The URL bar's stillness
  remains the staging idea: hold on it a half-second — no underline, no highlight; the stillness IS the
  callout.
- **Visual/Motion:** First phone shows the installed Immich page — green pulsing status dot with the muted
  'Running' label next to the action buttons (a dot plus text, not a badge); a simulated tap ripple lands
  on Open (Stop and Open are the visible buttons; Restart lives in the overflow menu), then the screen
  content slides left-to-right within the same frame to the live Immich timeline — one phone, one
  continuous gesture. Mid-scroll, the status-bar signal flips wifi → 5G with zero interruption and no
  callout — the literal coffee-shop proof, there for rewatchers. Hold on the URL bar for a half-second
  beat. End on a slow push-in: the payoff shot of the chapter.
- **Portrait:** The climax of the portrait cut — phone frame at full bleed, the tap and slide feel native,
  and the wifi → 5G flip reads at native scale. The URL is duplicated above the frame at caption size so
  the *.ci.computer domain is legible at vertical-video glance speed. No underline in either placement.

---

## Chapter 6 — Fleet view + outro (3:32–3:56)

Close the loop where it opened: the Portal dashboard now shows the device online and Immich installed,
the ownership tally lands, and the outro signs off. **Chapter gag (kept): the planted price-tag unhook** —
the video's only coral object and only $9.99 appearance, planted in the fleet beat and paid off at
'$0/month'. The diagram-ghost snap and the '100%' progress-rule joke are demoted; the grey→green status
tick and the teal rule under the chip stay as polish.

**Transition in:** teal-rule wipe (Portal direction). **Transition out:** fade to black after a 2s hold.

### 22. c6-close-fleet — screen, 10s (3:32–3:42)
- **Screens:** `portal-home-with-device` (browser, hub.ci.computer/home) ·
  `portal-home-with-device-mobile` (phone)
- **Caption:** Every device. Every app. One quiet dashboard.
- **Narration:** Back in the Portal, your Hub is online and your new apps are one click away — everything you just built, on hardware you own.
- **Gag:** none here (diagram-ghost snap demoted → Appendix A) — but this beat carries the **PLANT** for
  the tally: a tiny coral price tag already dangles faintly off the dashboard's corner, unexplained.
  Second-watch Easter egg; first-watch setup.
- **Visual/Motion:** Enter via the horizontal teal-rule wipe (specced in v1 prose only; timeline.tsx uses
  fade() — build the wipe new, see Production notes). Device card status dot ticks from grey
  (--ci-offline #6f808a) to green (--ci-success) with a 2-frame overshoot, timed to the narration word
  'online'. A teal connector line draws from the 'Living Room Server' card in the DevicesSidebar to the
  Immich tile in the AppLauncherGrid (connector treatment specced in v1 s12 notes; ScreenScene.tsx has no
  connector code — build new). Slow push-in 1.00→1.04 across the beat. Landscape: browser frame
  full-bleed, phone frame absent.
- **Portrait:** Phone frame leads, centered, showing the mobile Portal /home in its real single-column
  order: WorkspaceHeader ('1 device · 1 app') at top, AppLauncherGrid with the Immich tile, the 'Living
  Room Server' device card inline below the grid. Teal connector runs vertically UPWARD from device card
  to app tile. Capture is scrolled so both sit in frame at 390×844 (the device card won't fit unscrolled).
  Desktop frame small and angled behind the phone at ~55% scale, dimmed 30%. Coral tag dangles from the
  phone frame's top corner.

### 23. c6-close-tally — feature, 8s (3:42–3:50) — CHAPTER GAG
- **Screens:** none (overlay beat over the dimmed fleet view)
- **Caption:** Your hardware. Your domain. Your data. $0/month.
- **Narration:** Your own hardware, your own domain, your own data — and exactly zero subscriptions. Nothing left to cancel.
- **Gag (KEPT):** The coral (#F47C6C) price tag reading "$9.99/mo*" — planted dangling off the dashboard
  corner since the fleet beat — unhooks itself as the fourth chip lands and floats up out of frame, fading
  as it goes, its asterisk pointing to fine print too small to read. Coral is the style guide's single
  warm accent, reserved for the one element in the video that doesn't belong to the user. No confetti —
  the joke is the silence.
- **Visual/Motion:** The fleet view dims to ~25% and blurs slightly (the coral tag stays faintly legible
  on its corner until the unhook); four pill chips pop in sequentially on a 6-frame stagger across a 2×2
  grid (Montserrat 600, teal border on navy): 'Your hardware' / 'Your domain' / 'Your data' / '$0/month',
  each landing with a small check tick. The fourth chip settles with a gentle scale ease, no bounce, and
  triggers the unhook. After the tag fades off the top of frame, hold 12–15 frames with no motion at all —
  the silence is the button — then cross-dissolve to the outro.
- **Portrait:** Chips stack vertically as a single centered column (four rows) over the dimmed phone
  frame; coral tag dangles from the phone frame's top corner and floats off the top edge. Keep chips
  inside the 80%-width caption-safe zone.

### 24. c6-close-outro — outro, 6s (3:50–3:56)
- **Screens:** none
- **Caption:** ci.computer — Own your AI.
- **Narration:** Companion Intelligence. ci dot computer. Own your AI.
- **Gag:** none (the '100% / nothing follows it' progress-rule joke demoted → Appendix A). A plain teal
  rule still draws left-to-right beneath the ci.computer chip as CTA punctuation — polish, no label.
- **Visual/Motion:** Cross-dissolve into the existing OutroScene (`src/scenes/OutroScene.tsx`), matching
  its real order: CI logo fades/slides in (opacity + translateY) from f0, CTA line 'Own your AI.' enters
  at f16, gradient 'ci.computer' chip pops in LAST at f34 with its springy scale-in (damping 13). The
  chip's bounce settle triggers the teal-rule draw beneath it (NEW element — absent from OutroScene.tsx).
  Hold 2s on the settled frame, then fade to black. The extra second of hold lets the TTS line finish
  clean.
- **Portrait:** Re-stack the existing component for 9:16 without changing element/animation order: logo
  at the upper-third anchor, CTA line mid-frame, ci.computer chip below it (still entering last with its
  spring). Teal rule draws at the chip's width rather than full-bleed. All within 9:16 title-safe margins.

---

## Production notes

### New build work (Remotion), in priority order
1. **Teal-rule wipe presentation** for TransitionSeries — timeline.tsx ships fade() only. Used at the
   three machine/place switches: c2→c3 (Portal→Hub), c5→c6 (phone→Portal), and vertically in portrait.
   Build once, parameterize direction.
2. **Phone frame component** + portrait restages of IntroScene, PlatformDiagram, OutroScene (element order
   unchanged; layout re-stacked). Portrait wordmark asset decision (crop banner SVG vs. Montserrat
   ExtraLight text) blocks the intro restage.
3. **PlatformDiagram changes:** Hub stagger index 0; roofline + porch light overlay; Portal sub-label
   crossfade prop ('Cloud control plane' ↔ 'Control plane').
4. **Gag overlays (one per chapter):** ToS-streamer cloud deflate (c1), stenographer slug type-on lag (c2 —
   the lag is animated, but mirrors real `generateSlugPreview()` behavior), support-ticket stub (c3),
   searching asterisk (c4), CPU exhale ease (c5), coral price-tag plant + unhook (c6).
5. **ScreenScene additions:** teal connector line (c6 fleet), three-stop registration progress overlay
   (c3), lifecycle stage strip (c4), custom portrait URL chip (c4/c5 live shots), simulated cursor + tap
   ripple, odometer counter overlay (c4 catalog app count).
6. **OutroScene:** teal rule draw beneath the chip.

### Capture session plan (see shots-v2.json for full states)
- **One pairing session** captures portal-add-device-dialog, portal-pairing-code-dialog (+ post-copy
  take), portal-pairing-code-dialog-mobile (same 6-char code across viewports — or composite the code in
  Remotion; composited glyphs must match the product's monospace exactly; UI reproduction is the only
  acceptable non-Montserrat text), and the three hub-device-registration desktop phases + two mobile
  phases (timing-sensitive; the status card replaces the form in pending phases, and the code clears on
  success).
- **One live-install session** on a fleet/test device captures the Immich lifecycle frames (several
  mid-install frames for the stage ticks), app-immich-live + app-immich-live-mobile (seeded demo library;
  install with custom local subdomain 'immich' so the hostname reads immich-<device>-<org>.ci.computer —
  the default appSubdomain is `${appName}-${appStoreId}` and would leak the store slug; this also applies
  retroactively to v1's app-immich-live).
- **Zustand, not URLs:** Featured and companion-intelligence category filters are UI state — set
  programmatically before capture; there is no ?category= param and no companion-intelligence sidebar
  entry (`iconForCategory` omits it).
- **Resource monitor warm-up:** history is accumulated client-side from 60s polls — leave the page open
  2–3 cycles or mock `fetchAppRuntimeMonitor`.
- **Dashboard pairs:** hub-home-dashboard and hub-home-dashboard-mobile must capture the same data moment
  (numbers match for the side-by-side); CPU idle-ish ~10–20% so the c5 exhale reads.
- **Slug discipline:** device 'Living Room Server', one org slug everywhere ('acme' is the storyboard
  placeholder — substitute the real QA org slug uniformly at capture time, including every on-screen URL).
- **Verify the number 200** against the live /api search total before rendering the catalog odometer.

### Style invariants
- Montserrat for all caption/overlay text (sole exception: composited reproductions of product UI
  monospace). Background #041620 family — never pure black, never neutral gray stages.
- Accents: teal #82FCFC, mint #58EBBF, cyan/navy family. **Coral #F47C6C appears exactly once in the
  video** (c6 price tag, planted in c6-close-fleet). No confetti, no cartoon SFX; gags are silent or
  sub-audible.
- Gag grammar (house style): small UI elements with good manners — they arrive, do one polite thing, and
  leave. One booked gag per chapter; everything else is polish.
- Narration pacing ≈ 2.4 w/s average; no scene exceeds ~2.6. TTS via `scripts/gen-narration.sh` fed by
  `narration-v2.md`.

### Format strategy
- Landscape 1920×1080 and portrait 1080×1920 share the 236s master timeline; per-beat portrait notes
  restage composition. The 60-second portrait teaser is a separate edit (cut-list in `marketing-v2.md`).

---

## Appendix A — Demoted visual gag ideas (production options, not in the v2 cut)

Kept on file: if a chapter's booked gag dies in the animatic, promote from its own chapter's list first.

### c1-open
- Intro upload arrow rises off the banner, holds dead at its apex 3–4 frames, then curls back into the
  logo — the hesitation is the punchline; deadpan (no face, no squash, no sound).
- Porch light blinks on a half-beat AFTER the Hub card settles — the delay is the joke. (Roofline + porch
  light are still built, played straight.)
- All edges draw toward the Hub, never away — data flows home (kept in cut as texture, not a counted joke).
- Portal's sub-label quietly drops the word 'Cloud' for exactly the duration of the cloud joke (kept in
  cut as a prop, listed here for the record — it coordinates, it doesn't hoard).

### c2-portal
- Padlock overlay above the signup form clicks shut and gives one contented two-degree nod as the
  password dots fill. Nothing else moves.
- '$9.99/mo' coral price tag detaches from a flagship store card, drifts up, and pops like a soap bubble —
  superseded by the c6 plant/payoff.
- WorkspaceHeader device count rolls 0→1 with a single odometer tick behind the dimmed pairing dialog.
- Alternate UI-text gag (use at most one per section, never with the price tag): one store card's button
  briefly renders a ghosted 'Start 14-day trial' that dissolves into 'Install'.
- Copy confirmation played exactly as the product does it (kept in cut as sincere polish, not a gag).

### c3-hub
- EKG heartbeat blip: one tiny pulse travels along the teal rule under the registration status card the
  moment the complete phase lands — **first candidate to reinstate**; it pays off "Then it's alive."
- Install & Finish glint: tick, tick, glint on the same 6-frame grid (the section pre-authorized cutting
  it if it read as ambient polish — it did).
- Pointing-hand audit: outlined hand at ~2× cursor scale taps the DISK SPACE card; the count-up pauses
  8–10 frames, settles; the card dips 2px in acknowledgment. (Its narration line "Go ahead — point." was
  cut for pace; reinstate both together.)
- Registration phases as subway stops (kept in cut as texture). · Resource-monitor pen strokes (kept in
  cut as texture).

### c4-store
- Coral '$9.99/mo' price tag peels off a flagship card and floats away — superseded by the c6 plant/payoff.
- 'Also available on: —' muted spec line under one exclusive card; the em-dash is the entire list.
- '(We don't know them either.)' annotation beneath the install dialog at "you never see them."
- URL-bar padlock gives one small approving bounce as the subdomain finishes typing on.
- App-count odometer 195→200 (kept in cut as texture). · Mint running-pulse + stage-strip bow (kept in
  cut as polish). · Portrait URL chip (kept in cut as a functional element).

### c5-mobile
- Cloud icon wearing a small coral '$9.99/mo' tag tries to follow the phone into the pocket, doesn't fit,
  drifts off-screen — no face, standard ease-in-out; superseded by the c6 plant/payoff.
- Teal location pin hops couch → café cup → park bench and sits down on the bench while the
  *.ci.computer URL stays pinned, unchanged, un-underlined — geography gets tired; the address doesn't.
- Spare callback: the priced cloud drifts past tiny in the deep background of the open-anywhere beat,
  smaller, still unsold (depends on the demoted pocket cloud).
- wifi → 5G status-bar flip (kept in cut as ambient texture — no callout, for rewatchers).

### c6-close
- Diagram-ghost snap: the Portal/Hub/Marketplace spine of the Scene-02 five-node diagram ghosts in over
  the live dashboard for ~40 frames and snaps onto the WorkspaceHeader, device card, and Immich tile
  (1-frame ticks, staggered); Server and Clients nodes fade out untargeted. Strong structural callback —
  cut for one-gag-per-chapter; strongest candidate if c6 ever gets a second beat of air. ('The map became
  the territory' stays a production note only — never on-screen text.)
- Outro teal rule with a tiny mono '100%' label that ticks up, completes, holds, and fades — and nothing
  follows it: the one progress bar in the video that truly finishes. (Plain rule kept in cut, label and
  joke framing demoted.)
- Device status dot grey→green with tiny overshoot at the word 'online' (kept in cut as polish — the
  smallest possible victory animation).
