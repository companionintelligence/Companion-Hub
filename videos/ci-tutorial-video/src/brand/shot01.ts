/**
 * The "shot-01" treatment — geometry, palette and timing ported from
 * `graphic-frames/import-tools-v2`, the opening shot of the CI-Import-Tools
 * film ("01 - Pick your platforms").
 *
 * WHY THESE ARE LITERALS AND NOT EYEBALLED
 * Every number below was evaluated from CI-Common's video-kit — `stageFrames()`
 * and `FORMATS` in `src/camera.mjs` / `src/brand.mjs` — which is where the
 * reference generator gets them (`src/build.mjs`: "GEOMETRY comes from
 * video-kit, so the ground, the glows and the phone are the film's own").
 * They are frozen here rather than imported because video-kit is an ESM Node
 * package outside this Remotion project's module graph; if the kit's stage
 * geometry changes, re-evaluate and update these together.
 *
 *   node -e '...' from CI-Common/packages/video-kit produced:
 *     PHONE_BEZEL 3 · PHONE_STATUS_H 46
 *     portrait  stageInset 67 · phone 778×1429 · captionAllowance 297
 *     landscape stageInset 38 · browser 1488×883 · captionAllowance 159
 *
 * The device is ILLUSTRATED, not photographic: a 3px teal stroke, a flat body,
 * a pill notch. That is the whole visual difference from `PhoneFrame.tsx`,
 * which draws a titanium gradient, side buttons and a dynamic island.
 */

/** Colours are video-kit `brand.mjs` `color.*`, not this project's theme. */
export const SHOT01 = {
  bezel: 3,
  statusH: 46,
  phoneRadius: 46,
  browserRadius: 14,

  /** `color.tealDeep` — the stroke that makes the device read as a drawing. */
  stroke: '#2C676D',
  /** `color.card` — the device body. Note this is NOT theme.color.card. */
  body: '#0C323C',
  /** The screen well behind the content. */
  aperture: '#041620',
  phoneStatus: '#021018',
  chrome: '#073038',
  chromeRule: 'rgba(6,108,128,0.16)',
  text: '#E8F2F4',
  textMuted: '#A3BABF',
  /** The step eyebrow in the landscape reference. */
  step: '#C5E8DC',
  shadow: '0 40px 90px -40px rgba(0,0,0,0.9)',

  notch: {w: 150, h: 26, r: 14},

  /**
   * The phone insets its page to 94% of the aperture ("the 6% inset, kept" —
   * build.mjs), which reads as a screen bezel. The browser does NOT: its page
   * fills the chrome edge to edge, so landscape uses 1.
   */
  contentInset: 0.94,
  browserContentInset: 1,

  /**
   * The page must visibly travel top-to-bottom, as a fraction of the aperture
   * height. The reference gets 1487 CSS px of travel free because its subject is
   * a full-page capture 1.86 screens tall; this film's screens are VIEWPORT
   * captures, so a width-fit leaves 194px of overflow in portrait and exactly
   * zero in landscape — a scroll that does not move.
   *
   * So when the natural fit cannot supply this much travel, the page is scaled
   * up until it can and cropped horizontally about its centre. That is a pan
   * over a slightly enlarged capture, NOT a true page scroll: at 0.22 the
   * landscape browser reads about 22% in, losing ~11% off each side. The honest
   * fix is a full-page recapture (see `ci-import-tools-phone/README.md`, which
   * hit this exact wall and re-shot at `fullPage`); this keeps the motion until
   * those exist.
   */
  minTravel: 0.22,

  portrait: {
    phoneW: 778,
    phoneH: 1429,
    stageTop: 67,
    captionAllowance: 297,
    /** `fmt.titleSize * 0.85` and `fmt.subSize * 0.75`, per build.mjs. */
    titleSize: 65,
    subSize: 24,
    /** build.mjs: `restY + phoneH + 60 + 10`. */
    textGap: 70,
    /** build.mjs settles the device 15px above the stage centre. */
    restLift: 15,
  },

  landscape: {
    browserW: 1488,
    browserH: 883,
    chromeH: 46,
    dot: 11,
    urlSize: 17,
    captionBottom: 54,
    captionSize: 33,
    stepSize: 18.7,
  },

  /** Seconds. From build.mjs: SLIDE_END, TEXT_FADE, and the scroll window. */
  timing: {slideEnd: 1.4, textFade: 0.6},
} as const;

/**
 * Where the device sits and how big its screen well is, for one format. Shared
 * so the device and the caption that aligns to its left edge cannot disagree.
 */
export const shot01Geometry = (fmt: {isPortrait: boolean; w: number; h: number}) => {
  const P = SHOT01.portrait;
  const L = SHOT01.landscape;

  const devW = fmt.isPortrait ? P.phoneW : L.browserW;
  const devH = fmt.isPortrait ? P.phoneH : L.browserH;
  const chromeH = fmt.isPortrait ? SHOT01.statusH : L.chromeH;
  const bezel = fmt.isPortrait ? SHOT01.bezel : 1;

  return {
    devW,
    devH,
    chromeH,
    bezel,
    restX: Math.round((fmt.w - devW) / 2),
    restY: fmt.isPortrait
      ? Math.round(P.stageTop + (fmt.h - P.stageTop - P.captionAllowance - devH) / 2) -
        P.restLift
      : Math.round((fmt.h - devH) / 2),
    apertureW: devW - bezel * 2,
    apertureH: devH - bezel * 2 - chromeH,
    contentW: Math.round(
      (devW - bezel * 2) *
        (fmt.isPortrait ? SHOT01.contentInset : SHOT01.browserContentInset),
    ),
    /** Off-frame left, where the arrival starts. */
    offX: -(devW + 60),
  };
};

/** build.mjs eases the arrival so it settles rather than stopping dead. */
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
