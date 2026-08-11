import React from 'react';
import {Img, staticFile} from 'remotion';
import {clamp01, easeInOutSine, easeOutCubic} from '../brand/shot01';
import {Cursor, FocusRing, PressFlash, TypedField, moveTo} from '../components/screen-fx';
import {fontFamily} from '../brand/fonts';

/**
 * Per-cut interaction choreography, drawn over the captured plate.
 *
 * COORDINATES ARE PLATE PIXELS, measured off the committed PNG (all of these
 * are 3840×2160) and verified by cropping the capture at those coordinates
 * rather than read off a scaled preview. `Shot01Device` scales this layer by
 * exactly the plate's own factor, so one measurement holds at any aperture size
 * and in both formats where the two formats share a plate.
 *
 * WHY DRAWN AND NOT CAPTURED
 * These are signed-in dialogs behind an account with a paired device: they
 * cannot be re-shot the way the reference re-shot its ten toggle states. The
 * text typed is the text the product shows, over the product's own capture.
 */

export type ChoreoArgs = {
  /** Seconds into the cut. */
  t: number;
  /** Plate display scale — for anything that should hold a constant on-screen size. */
  k: number;
  isPortrait: boolean;
};

/** A click that has happened, or null before it does. */
const since = (t: number, at: number) => (t >= at ? t - at : null);

/* ------------------------------------------------------------------ cut-03 */
/**
 * c2-portal-name-device — "Name your device".
 *
 * The capture already contains "Living Room Server" in the field, so the field
 * is repainted in its own sampled fill (#122E3A) and the name typed into it.
 * The slug beneath derives from the name the way the product derives it, so it
 * fills in as the name does rather than appearing whole.
 *
 * Ends by clicking Continue and cross-fading to the pairing-code dialog — the
 * screen the product actually goes to, and the subject of the next cut.
 */
const NAME_FIELD = {x: 1527, y: 1082, w: 792, h: 58};
const SLUG_CHIP = {x: 1586, y: 1158, w: 282, h: 30};
const CONTINUE_BTN = {x: 2145, y: 1258, w: 173, h: 54};

const T3 = {
  toField: 0.15,
  clickField: 1.0,
  typeFrom: 1.25,
  typeTo: 3.35,
  toButton: 3.8,
  clickButton: 4.8,
  swap: 5.05,
};

const cut03 = ({t, k}: ChoreoArgs) => {
  const name = 'Living Room Server';
  const typed = clamp01((t - T3.typeFrom) / (T3.typeTo - T3.typeFrom));

  const start = {x: 3050, y: 1750};
  const atField = {x: NAME_FIELD.x + 250, y: NAME_FIELD.y + 34};
  const atButton = {x: CONTINUE_BTN.x + 88, y: CONTINUE_BTN.y + 30};

  const p =
    t < T3.toButton
      ? moveTo(t, start, atField, T3.toField, 0.8)
      : moveTo(t, atField, atButton, T3.toButton, 0.85);

  // The next screen, cross-faded in after Continue is pressed.
  const swap = easeOutCubic(clamp01((t - T3.swap) / 0.5));

  return (
    <>
      <TypedField
        rect={NAME_FIELD}
        fill="#122E3A"
        text={name}
        progress={typed}
        fontSize={34}
        padX={24}
        caretAt={t >= T3.clickField && t < T3.toButton ? t : null}
      />
      {/* The slug chip tracks the name, slugified, as the product does. */}
      <TypedField
        rect={SLUG_CHIP}
        fill="#0E2733"
        text={name.toLowerCase().replace(/\s+/g, '-')}
        progress={typed}
        fontSize={22}
        padX={8}
        mono
        color="#9BB4BB"
      />
      {t >= T3.clickField && t < T3.toButton ? (
        <FocusRing rect={NAME_FIELD} t={t - T3.clickField} radius={12} />
      ) : null}
      <PressFlash rect={CONTINUE_BTN} sinceClick={since(t, T3.clickButton)} radius={12} />

      {swap > 0 ? (
        <div style={{position: 'absolute', inset: 0, opacity: swap}}>
          <Img
            src={staticFile('screens/portal-pairing-code-dialog.png')}
            style={{width: '100%', height: '100%', display: 'block'}}
          />
        </div>
      ) : null}

      {/* The pointer sits above the swap so the click that caused it stays visible. */}
      <Cursor
        x={p.x}
        y={p.y}
        size={54 / k}
        sinceClick={
          since(t, T3.clickButton) ?? (t < T3.toButton ? since(t, T3.clickField) : null)
        }
      />
    </>
  );
};

/* ------------------------------------------------------------- the registry */

export type Choreo = (args: ChoreoArgs) => React.ReactNode;

/** Scene id → overlay. Absent means the cut plays as a plain scroll. */
export const CHOREOGRAPHY: Record<string, Choreo> = {
  'c2-portal-name-device': cut03,
};

/* ------------------------------------------------------------------ cut-04 */
/**
 * c2-portal-pairing-code — the Device Pairing Code modal.
 *
 * NO SCROLL AND NO PAN, by direction: the plate is a modal at exactly one
 * viewport, so there was never anything to scroll, and the 22% enlarge-and-crop
 * that manufactured travel elsewhere only advertised that fact. It holds still
 * and the interaction carries the beat.
 *
 * Copy is clicked first — with the "Copied" confirmation the product shows —
 * then Open in Companion Hub. The code on screen is LRSV01, which is the code
 * pasted into the Hub in the next cut; they are the same string on purpose.
 */
const PAIR = {
  landscape: {
    copy: {x: 2222, y: 942, w: 96, h: 96},
    open: {x: 1524, y: 1296, w: 794, h: 66},
    toast: {x: 2150, y: 855, size: 30},
    start: {x: 3100, y: 1800},
  },
  portrait: {
    copy: {x: 952, y: 1037, w: 144, h: 144},
    open: {x: 74, y: 1614, w: 1022, h: 101},
    toast: {x: 840, y: 940, size: 40},
    start: {x: 1050, y: 2200},
  },
};

const T4 = {toCopy: 0.4, clickCopy: 1.6, toOpen: 3.4, clickOpen: 5.0};

const cut04 = ({t, k, isPortrait}: ChoreoArgs) => {
  const G = isPortrait ? PAIR.portrait : PAIR.landscape;
  const atCopy = {x: G.copy.x + G.copy.w / 2, y: G.copy.y + G.copy.h / 2};
  const atOpen = {x: G.open.x + G.open.w * 0.42, y: G.open.y + G.open.h / 2};

  const p =
    t < T4.toOpen
      ? moveTo(t, G.start, atCopy, T4.toCopy, 1.0)
      : moveTo(t, atCopy, atOpen, T4.toOpen, 1.2);

  const copied = since(t, T4.clickCopy);
  const showToast = copied !== null && copied < 2.2;

  return (
    <>
      <PressFlash rect={G.copy} sinceClick={copied} radius={12} />
      <PressFlash rect={G.open} sinceClick={since(t, T4.clickOpen)} radius={12} />
      {showToast ? (
        <div
          style={{
            position: 'absolute',
            left: G.toast.x,
            top: G.toast.y - 26 * easeOutCubic(clamp01(copied! / 0.35)),
            background: 'rgba(13,58,56,0.96)',
            color: '#34D399',
            border: '2px solid rgba(52,211,153,0.5)',
            borderRadius: 999,
            padding: `${G.toast.size * 0.3}px ${G.toast.size * 0.7}px`,
            fontSize: G.toast.size,
            fontWeight: 700,
            opacity: clamp01((2.2 - copied!) / 0.4) * easeOutCubic(clamp01(copied! / 0.25)),
            whiteSpace: 'nowrap',
          }}
        >
          Copied
        </div>
      ) : null}
      <Cursor
        x={p.x}
        y={p.y}
        size={54 / k}
        sinceClick={since(t, T4.clickOpen) ?? (t < T4.toOpen ? copied : null)}
      />
    </>
  );
};

/* ------------------------------------------------------------------ cut-05 */
/**
 * c3-hub-claim — the Hub's "connect this device" screen.
 *
 * The field is clicked, then LRSV01 is PASTED: it appears whole rather than
 * typed, because that is what the beat is — the code copied one cut earlier
 * arriving in one go. The captured plates carry a placeholder (ABC123 on
 * desktop, B7K2Q9 on mobile), so the field is repainted in its own sampled fill
 * (#061A25) and the real code drawn in.
 */
const REG = {
  landscape: {
    field: {x: 2026, y: 1398, w: 340, h: 56},
    register: {x: 2388, y: 1392, w: 320, h: 68},
    size: 30,
    start: {x: 3150, y: 1850},
  },
  portrait: {
    field: {x: 192, y: 2234, w: 281, h: 100},
    register: {x: 508, y: 2228, w: 473, h: 112},
    size: 46,
    start: {x: 1050, y: 2450},
  },
};

const T5 = {toField: 0.5, clickField: 1.6, paste: 2.3, toBtn: 3.6, clickBtn: 5.2};

const cut05 = ({t, k, isPortrait}: ChoreoArgs) => {
  const G = isPortrait ? REG.portrait : REG.landscape;
  const atField = {x: G.field.x + G.field.w * 0.45, y: G.field.y + G.field.h / 2};
  const atBtn = {x: G.register.x + G.register.w / 2, y: G.register.y + G.register.h / 2};

  const p =
    t < T5.toBtn
      ? moveTo(t, G.start, atField, T5.toField, 1.0)
      : moveTo(t, atField, atBtn, T5.toBtn, 1.2);

  return (
    <>
      {/* Paste: the whole code at once, not typed character by character. */}
      <TypedField
        rect={G.field}
        fill="#061A25"
        text="LRSV01"
        progress={t >= T5.paste ? 1 : 0}
        fontSize={G.size}
        padX={G.size * 0.6}
        mono
        letterSpacing="0.12em"
        caretAt={t >= T5.clickField && t < T5.paste ? t : null}
      />
      {t >= T5.clickField && t < T5.toBtn ? (
        <FocusRing rect={G.field} t={t - T5.clickField} radius={10} />
      ) : null}
      <PressFlash rect={G.register} sinceClick={since(t, T5.clickBtn)} radius={10} />
      <Cursor
        x={p.x}
        y={p.y}
        size={54 / k}
        sinceClick={
          since(t, T5.clickBtn) ?? (t < T5.toBtn ? since(t, T5.clickField) : null)
        }
      />
    </>
  );
};

CHOREOGRAPHY['c2-portal-pairing-code'] = cut04;
CHOREOGRAPHY['c3-hub-claim'] = cut05;

/* ------------------------------------------------------------------ cut-06 */
/**
 * c3-hub-onboarding — "Set Up Your Hub".
 *
 * This is the one cut whose page genuinely scrolls: `hub-onboarding-form.png` is
 * a real full-page capture, 3840×10806, five screens tall. So the travel is a
 * true page scroll, and slowing it means covering less of the page — not moving
 * a zoomed screenshot around.
 *
 * TWELVE APPS. The captured page lists far more than twelve recommended apps,
 * and a plate cannot have rows removed from it. So the scroll STOPS while the
 * twelfth is on screen (`travel` in cuts.ts): the thirteenth is never reached,
 * which is what "only show 12" looks like from the viewer's side. If the list
 * itself must contain exactly twelve, that needs a composed screen like
 * `WorkspaceScreen`, not a capture.
 *
 * THE ACTION BAR IS DRAWN, not captured. A `position: fixed` footer is exactly
 * what a full-page screenshot cannot preserve — it is painted once, wherever it
 * happened to sit — so the bar is rendered in APERTURE space, outside the
 * scroller, which is what keeps it pinned while the page travels underneath.
 */
export const onboardingBar = ({
  apertureW,
  apertureH,
  isPortrait,
}: {
  apertureW: number;
  apertureH: number;
  isPortrait: boolean;
}) => {
  const s = apertureW / (isPortrait ? 772 : 1486);
  const h = s * (isPortrait ? 92 : 78);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: h,
        background: 'rgba(4,22,32,0.94)',
        borderTop: `${Math.max(1, s * 1.5)}px solid rgba(64,155,155,0.28)`,
        display: 'flex',
        alignItems: 'center',
        gap: s * 14,
        padding: `0 ${s * 20}px`,
        boxSizing: 'border-box',
        backdropFilter: 'blur(6px)',
        fontFamily,
      }}
    >
      {!isPortrait && (
        <div style={{flex: 1, minWidth: 0}}>
          <div style={{fontSize: s * 17, fontWeight: 700, color: '#E8F2F4'}}>
            12 apps selected
          </div>
          <div style={{fontSize: s * 12, color: '#9BB4BB', marginTop: s * 2}}>
            You can add or remove apps later from the Store.
          </div>
        </div>
      )}
      {isPortrait && (
        <div style={{flex: 1, fontSize: s * 20, fontWeight: 700, color: '#E8F2F4'}}>
          12 apps
        </div>
      )}
      <div
        style={{
          background: 'linear-gradient(90deg, #0F717A 0%, #17A2A2 100%)',
          color: '#04222A',
          fontWeight: 700,
          fontSize: s * (isPortrait ? 22 : 17),
          borderRadius: s * 10,
          padding: `${s * (isPortrait ? 16 : 13)}px ${s * (isPortrait ? 30 : 28)}px`,
          whiteSpace: 'nowrap',
        }}
      >
        Install &amp; Finish
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ cut-12 */
/**
 * c4-store-install — the "Install Immich" modal.
 *
 * Static by direction. The pointer crosses to the modal's Install button and
 * presses it; the plate is a modal at one viewport, so there is nothing to
 * scroll and no pan is manufactured.
 *
 * Coordinates measured off `hub-install-dialog-immich.png` (3840×2160); the
 * portrait cut shows the same plate, so the same rect serves both.
 */
const INSTALL_BTN = {x: 2383, y: 1329, w: 138, h: 79};
const T12 = {toBtn: 0.6, click: 2.2};

const cut12 = ({t, k}: ChoreoArgs) => {
  const start = {x: 3200, y: 1900};
  const at = {x: INSTALL_BTN.x + INSTALL_BTN.w / 2, y: INSTALL_BTN.y + INSTALL_BTN.h / 2};
  const p = moveTo(t, start, at, T12.toBtn, 1.2);
  const clicked = since(t, T12.click);

  return (
    <>
      <PressFlash rect={INSTALL_BTN} sinceClick={clicked} radius={10} />
      <Cursor x={p.x} y={p.y} size={54 / k} sinceClick={clicked} />
    </>
  );
};

CHOREOGRAPHY['c4-store-install'] = cut12;

/* --------------------------------------------------- cut-06, plate cleanup */
/**
 * Paints out the action bar that is BAKED INTO the onboarding plate.
 *
 * `hub-onboarding-form.png` is a full-page capture, and the page's action bar
 * is `position: fixed`. A full-page screenshot cannot honour that: the bar is
 * painted once, wherever it happened to sit when the capture ran — here at
 * plate y 1978-2126, stranded mid-page over the model grid. It then scrolls
 * past like any other content, while the real pinned bar sits at the bottom of
 * the aperture, so the cut showed two of them.
 *
 * The correct fix is a recapture with the footer hidden, which needs an
 * authenticated Hub session. Until then the strip is repainted with what it
 * covers: the container ground, and the three model cards of that row, so the
 * grid keeps its gutters instead of merging into one wide card.
 *
 * Colours and rects are sampled and measured from the plate, not invented.
 */
const STRANDED_BAR = {y: 1974, h: 158};
/** The section container, and the three model cards in that row. Edges detected
 *  off a clean row of the same grid (y=2500), not estimated. */
const CONTAINER = {x: 596, w: 2648};
const MODEL_COLS = [
  {x: 642, w: 828},
  {x: 1504, w: 830},
  {x: 2366, w: 832},
];
/** Sampled from that clean row: the two fills are within ~2 levels of each
 *  other, which is why the patch disappears instead of reading as a band. */
const FILL = {ground: '#081F2B', card: '#09212C', border: 'rgba(44,103,109,0.30)'};

const cut06 = () => (
  <>
    <div
      style={{
        position: 'absolute',
        left: CONTAINER.x,
        top: STRANDED_BAR.y,
        width: CONTAINER.w,
        height: STRANDED_BAR.h,
        background: FILL.ground,
      }}
    />
    {/* The cards' side borders are redrawn, or the grid would lose its edges
        for the height of the patch and read as one merged block. */}
    {MODEL_COLS.map((c) => (
      <div
        key={c.x}
        style={{
          position: 'absolute',
          left: c.x,
          top: STRANDED_BAR.y,
          width: c.w,
          height: STRANDED_BAR.h,
          background: FILL.card,
          borderLeft: `2px solid ${FILL.border}`,
          borderRight: `2px solid ${FILL.border}`,
          boxSizing: 'border-box',
        }}
      />
    ))}
  </>
);

CHOREOGRAPHY['c3-hub-onboarding'] = cut06;
