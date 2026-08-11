import {SCENES, V2Scene, V2Screen} from '../v2/scenes';

/**
 * The cut list — one compositing layer per screen beat of the film.
 *
 * Derived from `scenes-v2.json` rather than hand-written, so a scene added to
 * the storyboard cannot silently fail to get a cut, and a shot renamed in one
 * place cannot leave the other pointing at a file that no longer exists.
 *
 * A cut is device + screen on transparency: no ground, no caption, no voice.
 */
export type Cut = {
  /** Scroll speed multiplier — 1.3 finishes the travel in 1/1.3 of the window, then holds. */
  speed: number;
  /** `hub-cut-01` … `hub-cut-19`. */
  id: string;
  /** The storyboard scene this came from, for traceability. */
  sceneId: string;
  durationInSeconds: number;
  /** Shot shown in the 1920×1080 cut (browser frame). */
  landscape: V2Screen;
  /** Shot shown in the 1080×1920 cut (phone frame). */
  portrait: V2Screen;
  /**
   * Does the device slide in? Only the FIRST cut does. Everywhere else the
   * device is already at rest and never moves — only the screen content does.
   */
  enters: boolean;
  /**
   * Page travel, 0..1 of the plate's overflow.
   *
   * `from` is not always 0. Where a cut shows the SAME shot as the cut before
   * it, it opens on exactly the scroll position that one closed at, so the join
   * is continuous — the last frame of the previous image sets the first frame
   * of the next. Where the shot changes, the join is carried by the device,
   * which is pixel-identical across every cut because it never moves.
   */
  from: number;
  to: number;
};

const pick = (scene: V2Scene, want: 'browser' | 'phone'): V2Screen =>
  scene.screens.find((s) => (s.frame ?? 'browser') === want) ?? scene.screens[0];

/**
 * Shots that have a FULL-PAGE plate, keyed by the storyboard's shotId.
 *
 * This is the difference between a cut whose page genuinely scrolls and one
 * that pans over an enlarged viewport shot. The film's committed captures are
 * all one viewport — `portal-store-public.png` is exactly 16:9 — so scrolling
 * them means scaling them up first (`SHOT01.minTravel`) and cropping the sides.
 * A plate listed here is used at its natural scale and simply scrolls.
 *
 * Add to this map as `cuts/hub-cut-01/src/capture-full.mjs` (or an equivalent)
 * is pointed at more pages. The map is explicit rather than a filesystem probe
 * because the renderer runs in a browser and cannot stat the public folder.
 */
const FULL_PLATES: Record<string, string> = {
  'portal-store-public': 'portal-store-full',
  'portal-store-public-mobile': 'portal-store-full.mobile',
};

/** Public path (under public/) of the plate a cut should show for one screen. */
export const plateFor = (screen: V2Screen): string =>
  `screens/${FULL_PLATES[screen.shotId] ?? screen.shotId}.png`;

/** True when this screen scrolls a real full-page capture rather than a pan. */
export const hasFullPlate = (screen: V2Screen): boolean =>
  Object.prototype.hasOwnProperty.call(FULL_PLATES, screen.shotId);

/** How far a single cut travels its page. Full length unless it is a continuation. */
const TRAVEL = 1;

/**
 * Per-cut direction, keyed by storyboard scene id rather than cut number so a
 * scene added or excluded upstream cannot silently reassign someone else's
 * settings.
 *
 * `travel` scales how far the page moves — 0.9 is a 10% slower scroll over the
 * same window. `addSeconds` lengthens the cut, which slows it further; both are
 * applied where both are given.
 */
const OVERRIDES: Record<
  string,
  {addSeconds?: number; travel?: number; noScroll?: boolean; speed?: number; plate?: string}
> = {
  // hub-cut-01: +5s and a 10% slower scroll, by direction.
  'c2-portal-window-shop': {addSeconds: 5, travel: 0.9},
  // hub-cut-02: holds still. The workspace is a fixed layout, not a long page —
  // panning it only betrayed that there was nothing to scroll.
  'c2-portal-workspace': {noScroll: true},
  // hub-cut-03: holds still; the interaction is the motion, not the page.
  'c2-portal-name-device': {noScroll: true},
  // hub-cut-04: a modal at exactly one viewport — no scroll AND no pan.
  'c2-portal-pairing-code': {noScroll: true},
  // hub-cut-05: same; the paste and the click are the beat.
  'c3-hub-claim': {noScroll: true},
  // hub-cut-06: a real full-page plate. Stopping at 0.42 leaves the scroll on
  // the twelfth recommended app, so a thirteenth is never reached — and a
  // shorter travel over the same 12s is itself the slower scroll asked for.
  'c3-hub-onboarding': {travel: 0.42},
  // hub-cut-09: 30% faster — the same travel completed in 1/1.3 of the window,
  // then held, rather than a longer distance the plate does not have.
  'c4-store-catalog': {speed: 1.3},
  // hub-cut-10 / 11 / 12 / 13: composed or modal screens — nothing scrolls.
  'c4-store-exclusives': {noScroll: true},
  'c4-store-privacy': {noScroll: true},
  'c4-store-install': {noScroll: true},
  'c4-store-lifecycle': {noScroll: true},
  // hub-cut-14 / 18: hold the screen — no scroll, and no manufactured pan.
  'c4-store-live': {noScroll: true},
  'c6-close-fleet': {noScroll: true},
  // hub-cut-15 / 16: these beats are scripted as mobile but were showing a phone
  // capture inside a browser frame in the landscape cut. Both now use the
  // desktop plate in both formats, the way hub-cut-12 does.
  'c5-mobile-portal-pocket': {plate: 'portal-home'},
  'c5-mobile-hub-vitals': {plate: 'hub-home-dashboard'},
};

/** Scene id → a plate that replaces BOTH formats' shots. */
export const PLATE_OVERRIDE: Record<string, string> = Object.fromEntries(
  Object.entries(OVERRIDES)
    .filter(([, o]) => o.plate)
    .map(([id, o]) => [id, o.plate as string]),
);

/**
 * Screen beats that do NOT become cuts.
 *
 * `c2-portal-signup` is the login screen, cut by direction. Dropping it also
 * keeps `hub-cut-01` pointing at the store page — the cut that was built and
 * shipped first — rather than silently renumbering every layer on disk.
 */
const EXCLUDED = new Set(['c2-portal-signup']);

export const CUTS: Cut[] = (() => {
  const scened = SCENES.filter(
    (s) => s.screens && s.screens.length > 0 && !EXCLUDED.has(s.id),
  );
  const out: Cut[] = [];

  scened.forEach((scene, i) => {
    const landscape = pick(scene, 'browser');
    const portrait = pick(scene, 'phone');
    const prev = out[out.length - 1];

    // Continuous only when BOTH formats carry on from the same plate — a cut
    // that continues in portrait but cuts to a new page in landscape is not a
    // continuation, and pretending otherwise would desync the two deliverables.
    const continues =
      Boolean(prev) &&
      prev.portrait.shotId === portrait.shotId &&
      prev.landscape.shotId === landscape.shotId;

    const from = continues ? prev.to : 0;
    const o = OVERRIDES[scene.id] ?? {};

    out.push({
      id: `hub-cut-${String(i + 1).padStart(2, '0')}`,
      sceneId: scene.id,
      durationInSeconds: scene.durationInSeconds + (o.addSeconds ?? 0),
      landscape,
      portrait,
      enters: i === 0,
      speed: o.speed ?? 1,
      from,
      to: o.noScroll ? from : Math.min(1, from + TRAVEL * (o.travel ?? 1)),
    });
  });

  return out;
})();

export const cutById = (id: string): Cut | undefined => CUTS.find((c) => c.id === id);

/**
 * Remotion composition id for a cut. Remotion only accepts [a-zA-Z0-9-], which
 * `hub-cut-07-portrait` satisfies; it is also the output filename, so the
 * rendered file is named after the composition that produced it.
 */
export const compositionId = (cutId: string, format: 'landscape' | 'portrait') =>
  `${cutId}-${format}`;
