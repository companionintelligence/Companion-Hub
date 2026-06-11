import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {color, font} from '../../brand/theme';
import {fontFamily} from '../../brand/fonts';

/**
 * The video's single coral object — a "$9.99/mo*" price tag. Coral is the style
 * guide's one warm accent, reserved for the only thing on screen that doesn't
 * belong to the user.
 *  - mode 'plant'  (c6-close-fleet): dangles faintly off a corner, unexplained.
 *  - mode 'unhook' (c6-close-tally): hangs, then unhooks and floats up out of
 *    frame as the "$0/month" chip lands — fading, asterisk pointing at fine
 *    print too small to read. No confetti; the joke is the silence.
 */
export const PriceTag: React.FC<{
  mode: 'plant' | 'unhook';
  /** absolute anchor for the tag's hook point */
  left: number;
  top: number;
  /** for 'unhook': frame at which it releases */
  releaseAt?: number;
}> = ({mode, left, top, releaseAt = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const sway = Math.sin(frame / 14) * 3;
  let dx = 0;
  let dy = 0;
  let opacity = mode === 'plant' ? 0.55 : 0.6;
  let rot = sway;

  if (mode === 'unhook') {
    const rel = spring({
      frame: frame - releaseAt,
      fps,
      config: {damping: 60, stiffness: 30},
      durationInFrames: 60,
    });
    dy = -rel * 520;
    dx = rel * 60;
    rot = sway + rel * 12;
    opacity = interpolate(frame, [releaseAt, releaseAt + 14, releaseAt + 50], [0.6, 0.7, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: left + dx,
        top: top + dy,
        opacity,
        transform: `rotate(${rot}deg)`,
        transformOrigin: 'top left',
        fontFamily,
      }}
    >
      {/* string to the hook */}
      <svg width={40} height={30} style={{position: 'absolute', left: 6, top: -22}}>
        <line x1="2" y1="0" x2="14" y2="26" stroke={color.coral} strokeWidth="1.5" opacity={0.6} />
      </svg>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(244,124,108,0.16)',
          border: `1.5px solid ${color.coral}`,
          borderRadius: 8,
          padding: '8px 14px',
          color: color.coral,
          fontSize: 26,
          fontWeight: font.weight.semibold,
          boxShadow: '0 8px 22px -14px rgba(244,124,108,0.6)',
        }}
      >
        {/* hole punch */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            border: `1.5px solid ${color.coral}`,
            opacity: 0.7,
          }}
        />
        $9.99/mo
        <span style={{fontSize: 16, verticalAlign: 'super', opacity: 0.8}}>*</span>
      </div>
    </div>
  );
};
