import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {color, gradient} from '../brand/theme';

/**
 * The CI dark appliance canvas: deep teal-navy ground, the signature radial
 * depth lift, and two very slow drifting glows (mint + cyan) at whisper alpha.
 */
export const GradientBackground: React.FC<{children?: React.ReactNode}> = ({
  children,
}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const t = frame / Math.max(durationInFrames, 1);

  const driftX = interpolate(t, [0, 1], [-60, 60]);
  const driftY = interpolate(t, [0, 1], [30, -30]);

  return (
    <AbsoluteFill style={{backgroundColor: color.bg}}>
      <AbsoluteFill style={{backgroundImage: gradient.bgDepth}} />
      <div
        style={{
          position: 'absolute',
          width: 1400,
          height: 1400,
          left: -400 + driftX,
          top: 300 + driftY,
          background:
            'radial-gradient(circle, rgba(88,235,191,0.07) 0%, transparent 60%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1200,
          height: 1200,
          right: -350 - driftX,
          top: -500 - driftY,
          background:
            'radial-gradient(circle, rgba(130,255,255,0.06) 0%, transparent 60%)',
        }}
      />
      {children}
    </AbsoluteFill>
  );
};
