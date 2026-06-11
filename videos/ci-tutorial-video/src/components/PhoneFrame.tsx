import React from 'react';
import {Img, interpolate, staticFile} from 'remotion';
import {color} from '../brand/theme';

/**
 * A phone device frame around a mobile (390×844) screenshot. Dark titanium
 * bezel, dynamic-island notch, on-brand teal screen glow. `height` is the
 * outer device height in px; the screen aspect is locked to 9:19.5.
 */
export const PhoneFrame: React.FC<{
  src: string;
  height: number;
  /** 0..1 slow Ken Burns pan over the screenshot. */
  pan?: number;
  glow?: boolean;
}> = ({src, height, pan = 0, glow = true}) => {
  const bezel = Math.round(height * 0.018);
  const radius = Math.round(height * 0.085);
  const screenRadius = radius - bezel;
  const width = Math.round((height * 9) / 19.5);
  const islandW = Math.round(width * 0.32);
  const islandH = Math.round(height * 0.018);

  // Pan the screenshot vertically (mobile screens are tall, so reveal downward).
  const objY = interpolate(pan, [0, 1], [0, -6]);

  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: radius,
        background: 'linear-gradient(160deg, #1b2a30 0%, #0a161c 60%, #16242a 100%)',
        padding: bezel,
        boxShadow: glow
          ? `0 40px 90px -30px rgba(1,9,14,0.8), 0 0 70px rgba(130,252,252,0.12), inset 0 0 2px rgba(130,252,252,0.25)`
          : '0 40px 90px -30px rgba(1,9,14,0.8)',
      }}
    >
      {/* side buttons */}
      <div
        style={{
          position: 'absolute',
          left: -2,
          top: height * 0.22,
          width: 3,
          height: height * 0.09,
          borderRadius: 2,
          background: '#243238',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: -2,
          top: height * 0.28,
          width: 3,
          height: height * 0.12,
          borderRadius: 2,
          background: '#243238',
        }}
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          borderRadius: screenRadius,
          overflow: 'hidden',
          background: color.bg,
        }}
      >
        <Img
          src={staticFile(src)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: `center ${objY}%`,
          }}
        />
        {/* dynamic island */}
        <div
          style={{
            position: 'absolute',
            top: islandH,
            left: '50%',
            transform: 'translateX(-50%)',
            width: islandW,
            height: islandH * 1.6,
            borderRadius: islandH,
            background: '#05090c',
          }}
        />
      </div>
    </div>
  );
};
