import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {font} from '../../brand/theme';
import {fontFamily} from '../../brand/fonts';
import {useFormat} from '../../brand/format';

/**
 * c1-open-cloud-joke: a gray cloud puff drifts in towing a "We've updated our
 * Terms of Service" banner like a parade streamer, then deflates unprompted —
 * the streamer crumpling with it — while the Hub's porch light glows in answer
 * (the porch brightening is driven by DiagramScene). Enters from the frame edge
 * opposite the Portal card so it's never read as our Portal.
 */
export const CloudJoke: React.FC = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const fmt = useFormat();

  // drift in over first third, deflate ~45%→65%
  const driftIn = interpolate(frame, [0, durationInFrames * 0.32], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const deflate = interpolate(
    frame,
    [durationInFrames * 0.46, durationInFrames * 0.66],
    [1, 0.06],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const fade = interpolate(
    frame,
    [durationInFrames * 0.6, durationInFrames * 0.72],
    [1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  // Enter top-right (opposite the Portal card, which is upper-left/landscape, upper-center/portrait)
  const startX = fmt.w + 200;
  const endX = fmt.isPortrait ? fmt.w * 0.62 : fmt.w * 0.72;
  const x = interpolate(driftIn, [0, 1], [startX, endX]);
  const y = fmt.isPortrait ? fmt.h * 0.12 : fmt.h * 0.16;

  const cloudScale = deflate;
  const streamerW = 280 * deflate;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity: fade,
        fontFamily,
        transformOrigin: 'left center',
      }}
    >
      {/* streamer banner trailing to the right of the cloud */}
      <div
        style={{
          position: 'absolute',
          left: 70,
          top: 22,
          width: streamerW,
          height: 30,
          background: '#3a4750',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 12,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          color: '#c9d4d8',
          fontSize: 15,
          fontWeight: font.weight.medium,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
          transform: `skewX(-6deg)`,
        }}
      >
        We've updated our Terms of Service
      </div>
      {/* the cloud puff */}
      <svg
        width={150}
        height={90}
        viewBox="0 0 150 90"
        style={{transform: `scale(${cloudScale})`, transformOrigin: 'left center'}}
      >
        <g fill="#9aa6ac">
          <circle cx="45" cy="50" r="28" />
          <circle cx="75" cy="40" r="32" />
          <circle cx="105" cy="52" r="26" />
          <rect x="40" y="50" width="70" height="28" rx="14" />
        </g>
      </svg>
    </div>
  );
};
