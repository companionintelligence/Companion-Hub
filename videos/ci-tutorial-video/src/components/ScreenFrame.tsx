import React from 'react';
import {
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {color, font, radius, shadow} from '../brand/theme';
import {fontFamily} from '../brand/fonts';

export type KenBurns = {
  from: {scale: number; x: number; y: number};
  to: {scale: number; x: number; y: number};
};

const DEFAULT_MOVE: KenBurns = {
  from: {scale: 1, x: 0, y: 0},
  to: {scale: 1.06, x: 0, y: -2},
};

/**
 * Browser-chrome frame around a product screenshot, with a slow Ken Burns
 * move. `src` is a path under public/ (e.g. "screens/hub-home.png").
 * x/y in the move are percentage translations of the screenshot.
 */
export const ScreenFrame: React.FC<{
  src: string;
  url?: string;
  move?: KenBurns;
  width?: number;
}> = ({src, url, move = DEFAULT_MOVE, width = 1560}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();

  const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: 25});
  const t = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const scale = interpolate(t, [0, 1], [move.from.scale, move.to.scale]);
  const x = interpolate(t, [0, 1], [move.from.x, move.to.x]);
  const y = interpolate(t, [0, 1], [move.from.y, move.to.y]);

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '46%',
        transform: `translate(-50%, -50%) scale(${0.96 + enter * 0.04})`,
        opacity: enter,
        width,
        borderRadius: radius.xl,
        border: `1px solid ${color.borderStrong}`,
        boxShadow: `${shadow.card}, 0 0 80px rgba(130,252,252,0.08)`,
        overflow: 'hidden',
        background: color.surface,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '14px 20px',
          background: color.surface2,
          borderBottom: `1px solid ${color.borderSoft}`,
          fontFamily,
        }}
      >
        <div style={{display: 'flex', gap: 8}}>
          {[color.danger, color.warning, color.success].map((c) => (
            <div
              key={c}
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                background: c,
                opacity: 0.75,
              }}
            />
          ))}
        </div>
        {url ? (
          <div
            style={{
              flex: 1,
              maxWidth: 720,
              margin: '0 auto',
              textAlign: 'center',
              background: color.bg,
              border: `1px solid ${color.borderSoft}`,
              borderRadius: 999,
              padding: '6px 18px',
              color: color.textMuted,
              fontSize: 18,
              fontWeight: font.weight.medium,
            }}
          >
            {url}
          </div>
        ) : (
          <div style={{flex: 1}} />
        )}
        <div style={{width: 56}} />
      </div>
      <div style={{aspectRatio: '16 / 9', overflow: 'hidden'}}>
        <Img
          src={staticFile(src)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'top',
            transform: `scale(${scale}) translate(${x}%, ${y}%)`,
          }}
        />
      </div>
    </div>
  );
};
