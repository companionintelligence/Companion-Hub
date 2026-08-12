# CI Tutorial Video — editorial reference (static archive, no Remotion install)

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Editorial source material for a first-time-user-experience tutorial covering
**Portal → Hub → App Store / Marketplace** and back to the fleet view. Originally built
as a runnable [Remotion](https://remotion.dev) project (React-authored, deterministic
render); the platform's video renderer is now **HyperFrames**
(`CI-Engineering/projects/product-video-pipeline`), chosen specifically to avoid
Remotion's Company License requirement for commercial use by orgs with 4+ employees.

The Remotion install (`package.json`, `pnpm-lock.yaml`, `remotion.config.ts`,
`tsconfig.json`, `src/`, `scripts/render-cuts.mjs`) has been removed, including a set of
transparent alpha-layer compositing cuts added on top of it. What remains is the
**static editorial reference** the HyperFrames build already leans on — storyboard,
narration audio, and screenshots — per
`CI-Engineering/projects/product-video-pipeline/app-matrix.md`. This is reference
material only; it does not render on its own.

## Rebuilding this natively in HyperFrames

The removed Remotion code covered two needs. Neither requires Remotion — both are
native HyperFrames CLI features (confirmed against `github.com/heygen-com/hyperframes`
docs, not assumed):

1. **Transparent alpha-layer output** (device+screen compositing cuts, no ground/caption/
   voiceover). HyperFrames renders this directly: `hyperframes render --format webm` or
   `--format mov` (ProRes 4444 editing intermediate) — leave the composition background
   unpainted and it stays transparent. See the upstream
   [`rendering`](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/rendering.mdx)
   and [`remove-background`](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/remove-background.mdx)
   guides.
2. **UI states no capture can express** (a store listing never shown live, apps removed
   mid-list, a mid-install state). HyperFrames composes plain HTML/CSS/JS, the same way
   the rest of the platform's `video/` scenes already do — this is markup driven by live
   API data, not a React-specific capability. GSAP-based interaction choreography
   (pointer, typed field, focus ring, press flash) is likewise a documented HyperFrames
   pattern, not something Remotion uniquely provides.

Porting the actual compositing logic (`cuts.ts`, `choreography.tsx`, `Shot01Scene.tsx`,
`StoreScreens.tsx`, `WorkspaceScreen.tsx`, `screen-fx.tsx` — several thousand lines of
pixel-measured motion graphics) into HyperFrames scenes is real, sizeable work that
needs visual render verification to do safely; it was not attempted blind in this
cleanup. Nothing currently consumes the removed `/cuts` output (no `Shot01Scene` exists
in `video/`, no CI job references it), so there is no broken shipped deliverable —
this is a clean slate to rebuild from, not an urgent fix.

Brand tokens (palette, Montserrat, radii, gradients, motion) come from the
[Unified Style Guide](../../style.MD).

## Layout

```
storyboard/
  v2/           scenes-v2.json (source of truth), shots-v2.json, storyboard-v2.md,
                narration-v2.md, marketing-v2.md
  *.json,*.md   v1 storyboard (reference)
scripts/        gen-narration*.sh (Edge-TTS voiceover), gen_slates*.py (placeholder frames)
public/
  screens/      product screenshots (real captures + placeholder slates)
  audio/        per-scene narration mp3s (generated, see below)
  logos/        CI logo SVGs
  appicons/     marketplace app icons (added for the store-screen mockups; still useful reference)
```

`storyboard/v2/scenes-v2.json` is the editorial source of truth: scene order, durations,
captions, narration, the booked visual gag per chapter, and per-format `portraitNotes`.

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
server state. It is stood up locally and lives under `stage/` (git-ignored). A future
recapture only needs the PNGs already in `public/screens/` as a naming/framing guide.

## Brand

- Ground: deep teal-navy `#041620` (never pure black).
- Spine: teal `#0F717A` → mint `#58EBBF` → bright cyan `#82FFFF`.
- Single warm accent: coral `#F47C6C` — used exactly once (the price tag in the closing tally).
- Type: Montserrat (200/400/500/600/700).

See the [Unified Style Guide](../../style.MD).
