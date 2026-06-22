import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {color} from '../../brand/theme';
import {fontFamily} from '../../brand/fonts';
import {useFormat} from '../../brand/format';

/**
 * c4-store-privacy: a footnote asterisk fades in beside "No data collected,"
 * drifts down the App Privacy card hunting for fine print with two small
 * left-right nudges, holds one beat of stillness, finds none, and politely
 * fades out. The stillness before the fade is where the laugh lives.
 */
export const FinePrintAsterisk: React.FC<{
  /** anchor (fraction of frame) where the asterisk first appears */
  anchor?: {x: number; y: number};
}> = ({anchor}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const fmt = useFormat();

  // default near Immich's App Privacy card (lower-right on desktop, lower-center on phone)
  const ax = (anchor?.x ?? (fmt.isPortrait ? 0.6 : 0.72)) * fmt.w;
  const ay = (anchor?.y ?? (fmt.isPortrait ? 0.5 : 0.62)) * fmt.h;

  // appears late (after the narration line lands), hunts, holds, fades
  const start = durationInFrames * 0.42;
  const appear = interpolate(frame, [start, start + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const descend = interpolate(frame, [start + 10, start + 46], [0, 130], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // two small left-right nudges while descending
  const nudge =
    Math.sin((frame - start) / 4) *
    interpolate(frame, [start + 10, start + 40, start + 50], [0, 14, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  const fade = interpolate(
    frame,
    [durationInFrames - 18, durationInFrames - 6],
    [1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: ax + nudge,
        top: ay + descend,
        opacity: appear * fade,
        fontFamily,
        color: color.accent,
        fontSize: 64,
        fontWeight: 700,
        lineHeight: 1,
        textShadow: '0 0 18px rgba(130,252,252,0.4)',
      }}
    >
      *
    </div>
  );
};
