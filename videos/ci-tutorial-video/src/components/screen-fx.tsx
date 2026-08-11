import React from 'react';
import {clamp01, easeInOutSine, easeOutCubic} from '../brand/shot01';

/**
 * Interaction effects drawn ON TOP of a captured plate: a pointer, a click, a
 * field being typed into.
 *
 * WHY OVERLAYS AND NOT MORE PLATES
 * The reference film animates its toggles by cross-fading ten full-page
 * captures, one per state, because it could click the real app and re-shoot.
 * These screens cannot be re-shot: they are signed-in dialogs behind an account
 * with a paired device. So the interaction is drawn, and drawn honestly — the
 * text typed is the text the product would show, over the product's own capture.
 *
 * Everything here is positioned in PLATE PIXELS (the coordinate space of the
 * captured PNG) and scaled by the caller, so a coordinate measured once off the
 * capture stays correct at any aperture size.
 */

/** A cubic-bezier-ish pointer move that starts and stops gently. */
export const moveTo = (
  t: number,
  from: {x: number; y: number},
  to: {x: number; y: number},
  start: number,
  dur: number,
) => {
  const p = easeInOutSine(clamp01((t - start) / dur));
  return {x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p};
};

/**
 * The pointer. Drawn rather than captured — Playwright screenshots never
 * contain a cursor, so a captured plate cannot show one.
 */
export const Cursor: React.FC<{
  x: number;
  y: number;
  /** Plate px, so the pointer is the same physical size as the UI it points at. */
  size?: number;
  /** Seconds since the most recent click, or null if it has not clicked yet. */
  sinceClick?: number | null;
}> = ({x, y, size = 46, sinceClick = null}) => {
  // The click reads as a ring that expands and fades over ~0.45s.
  const ring = sinceClick === null ? null : clamp01(sinceClick / 0.45);

  return (
    <div style={{position: 'absolute', left: x, top: y, pointerEvents: 'none'}}>
      {ring !== null && ring < 1 && (
        <div
          style={{
            position: 'absolute',
            left: -size * 1.5 * ring,
            top: -size * 1.5 * ring,
            width: size * 3 * ring,
            height: size * 3 * ring,
            borderRadius: '50%',
            border: `${Math.max(2, size * 0.08)}px solid rgba(130,252,252,${(1 - ring) * 0.9})`,
          }}
        />
      )}
      <svg
        width={size}
        height={size * 1.35}
        viewBox="0 0 24 32"
        style={{display: 'block', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.6))'}}
      >
        <path
          d="M3 2 L3 24 L9 18.5 L13 27.5 L17 25.5 L13 17 L21 16 Z"
          fill="#FFFFFF"
          stroke="#04222A"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

/**
 * A rectangle painted over a region of the plate, with text typed into it.
 *
 * The paint matters: the captured field already contains its final value (the
 * add-device dialog ships with "Living Room Server" already in it), so the only
 * way to show it being typed is to cover the original and re-draw it. `fill`
 * should be sampled from the capture, not guessed, or the patch will read as a
 * patch.
 */
export const TypedField: React.FC<{
  /** Plate-pixel rect of the input's interior. */
  rect: {x: number; y: number; w: number; h: number};
  fill: string;
  text: string;
  /** 0..1 — how much of `text` has been typed. */
  progress: number;
  fontSize: number;
  color?: string;
  /** Left padding inside the field, plate px. */
  padX?: number;
  mono?: boolean;
  /** Show a blinking caret. `t` drives the blink. */
  caretAt?: number | null;
  letterSpacing?: string;
}> = ({
  rect,
  fill,
  text,
  progress,
  fontSize,
  color = '#E8F2F4',
  padX = 18,
  mono = false,
  caretAt = null,
  letterSpacing,
}) => {
  const shown = text.slice(0, Math.round(text.length * clamp01(progress)));
  const blink = caretAt === null ? false : Math.floor(caretAt * 2) % 2 === 0;

  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        background: fill,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: padX,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          fontSize,
          color,
          fontFamily: mono ? 'ui-monospace, Menlo, monospace' : undefined,
          letterSpacing,
          whiteSpace: 'nowrap',
        }}
      >
        {shown}
      </span>
      {caretAt !== null && blink && (
        <span
          style={{
            display: 'inline-block',
            width: Math.max(2, fontSize * 0.06),
            height: fontSize * 1.05,
            background: color,
            marginLeft: fontSize * 0.06,
          }}
        />
      )}
    </div>
  );
};

/**
 * A focus ring around a field, for the beat where it is clicked into before
 * anything is typed.
 */
export const FocusRing: React.FC<{
  rect: {x: number; y: number; w: number; h: number};
  t: number;
  radius?: number;
}> = ({rect, t, radius = 10}) => {
  const a = easeOutCubic(clamp01(t / 0.25));
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x - 3,
        top: rect.y - 3,
        width: rect.w + 6,
        height: rect.h + 6,
        border: `3px solid rgba(130,252,252,${0.85 * a})`,
        borderRadius: radius,
        boxShadow: `0 0 ${20 * a}px rgba(130,252,252,${0.35 * a})`,
        boxSizing: 'border-box',
      }}
    />
  );
};

/** A soft press highlight over a button that has just been clicked. */
export const PressFlash: React.FC<{
  rect: {x: number; y: number; w: number; h: number};
  sinceClick: number | null;
  radius?: number;
}> = ({rect, sinceClick, radius = 10}) => {
  if (sinceClick === null || sinceClick > 0.4) return null;
  const a = 1 - clamp01(sinceClick / 0.4);
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        background: `rgba(255,255,255,${0.16 * a})`,
        borderRadius: radius,
      }}
    />
  );
};
