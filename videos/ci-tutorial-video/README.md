# CI Tutorial Video — automated FTUE walkthrough (Remotion)

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

A fully code-rendered first-time-user-experience tutorial for the Companion
Intelligence platform, walking a new user across **Portal → Hub → App Store /
Marketplace** and back to the fleet view. Built with [Remotion](https://remotion.dev):
every scene is React, so the video re-renders deterministically from source — no
manual editing, no video timeline to maintain.

Brand tokens (palette, Montserrat, radii, gradients, motion) come straight from the
[Unified Style Guide](../../style.MD) and are encoded in [`src/brand/theme.ts`](src/brand/theme.ts).

## Outputs (compositions)

Registered in [`src/Root.tsx`](src/Root.tsx). One master timeline restages itself per
format — landscape leads with desktop UX, portrait leads with mobile UX.

| Composition ID | Size | Length | Use |
|---|---|---|---|
| `CIPlatformTour` | 1920×1080 | ~3:45 | Landscape / desktop (YouTube, site hero) |
| `CIPlatformTourPortrait` | 1080×1920 | ~3:45 | Mobile / vertical (Shorts, Reels, TikTok) |
| `CITeaserPortrait60` | 1080×1920 | ~0:56 | Social teaser cut |
| `CIPlatformTourV1` | 1920×1080 | ~3:00 | Original v1 cut, kept for reference |

## Quick start

```bash
pnpm install            # uses the project-local pnpm-workspace.yaml (esbuild build allowed)
pnpm studio             # open Remotion Studio to scrub/preview all compositions
pnpm render             # render the default composition to out/
# or a specific one:
npx remotion render CIPlatformTourPortrait out/ci-tour-portrait.mp4
```

Rendered files land in `out/` (git-ignored). FFmpeg is bundled by Remotion.

## Layout

```
src/
  brand/        theme.ts (CI tokens), format.ts (orientation system), fonts.ts
  components/   GradientBackground, CaptionBar, ScreenCarousel, PhoneFrame,
                PlatformDiagram, CILogo, gags/ (CloudJoke, …)
  scenes/       IntroScene, DiagramScene, ScreenScene, OutroScene
  v2/           timeline.tsx — the v2 cut, generated from storyboard/v2/scenes-v2.json
  timeline.tsx  v1 cut (reference)
  Root.tsx      composition registry
storyboard/
  v2/           scenes-v2.json (source of truth), shots-v2.json, storyboard-v2.md,
                narration-v2.md, marketing-v2.md
  *.json,*.md   v1 storyboard (reference)
scripts/        gen-narration*.sh (Edge-TTS voiceover), gen_slates*.py (placeholder frames)
public/
  screens/      product screenshots (real captures + placeholder slates)
  audio/        per-scene narration mp3s (generated, see below)
  logos/        CI logo SVGs
```

`storyboard/v2/scenes-v2.json` is the editorial source of truth: scene order, durations,
captions, narration, the booked visual gag per chapter, and per-format `portraitNotes`.
`src/v2/timeline.tsx` consumes it.

## Narration

Per-scene voiceover is generated with Microsoft Edge TTS (no API key):

```bash
pip install uv          # provides uvx, used by the script
./scripts/gen-narration-v2.sh     # writes public/audio/<sceneId>.mp3 from narration-v2.md
```

## Screenshots & the capture stage

`public/screens/*.png` are captured from the **real** Portal and Hub UIs. Surfaces that
are timing-sensitive or environment-gated (the Hub device-registration phases, the
onboarding wizard, and the live Immich install lifecycle) ship as branded placeholder
**slates** until captured on a stage with a paired device.

The local capture stage (Hub backend + frontend, Portal API + SPA, seeded marketplace
catalog, scripted FTUE states) is **not committed** — it contains dev credentials and
server state. It is stood up locally and lives under `stage/` (git-ignored). Re-render
only needs the PNGs already in `public/screens/`.

## Brand

- Ground: deep teal-navy `#041620` (never pure black).
- Spine: teal `#0F717A` → mint `#58EBBF` → bright cyan `#82FFFF`.
- Single warm accent: coral `#F47C6C` — used exactly once (the price tag in the closing tally).
- Type: Montserrat (200/400/500/600/700).

See [`src/brand/theme.ts`](src/brand/theme.ts) and the [Unified Style Guide](../../style.MD).
