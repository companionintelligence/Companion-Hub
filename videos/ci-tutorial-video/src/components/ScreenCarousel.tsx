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
import {useFormat} from '../brand/format';
import {PhoneFrame} from './PhoneFrame';

export type Screen = {src: string; url?: string; frame?: 'browser' | 'phone'};

const XFADE = 12; // frames of crossfade between screens

/** Dark browser chrome (traffic lights + URL pill) wrapping a 16:9 screenshot. */
const BrowserFrame: React.FC<{
  src: string;
  url?: string;
  width: number;
  drift: number;
}> = ({src, url, width, drift}) => (
  <div
    style={{
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
            style={{width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.75}}
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
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
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
          transform: `scale(${drift})`,
        }}
      />
    </div>
  </div>
);

/**
 * Crossfades through N screenshots, each in browser- or phone-chrome with a
 * slow Ken Burns drift. Orientation-aware: in landscape it prefers the browser
 * shots, in portrait it prefers the phone shots — so the same scene reads right
 * in both compositions without bespoke per-scene layout.
 */
export const ScreenCarousel: React.FC<{screens: Screen[]}> = ({screens}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames, height} = useVideoConfig();
  const fmt = useFormat();

  const preferred = fmt.isPortrait ? 'phone' : 'browser';
  const matched = screens.filter((s) => (s.frame ?? 'browser') === preferred);
  const list = matched.length ? matched : screens;

  const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: 25});
  const per = durationInFrames / list.length;
  const phoneHeight = Math.round(height * (fmt.isPortrait ? 0.82 : 0.74));

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: fmt.isPortrait ? '44%' : '46%',
        transform: `translate(-50%, -50%) scale(${0.96 + enter * 0.04})`,
        opacity: enter,
      }}
    >
      <div style={{position: 'relative'}}>
        {list.map((sc, i) => {
          const start = i * per;
          const opacity =
            i === 0
              ? interpolate(frame, [start + per, start + per + XFADE], [1, 0], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                })
              : interpolate(
                  frame,
                  [start, start + XFADE, start + per, start + per + XFADE],
                  [0, 1, 1, i === list.length - 1 ? 1 : 0],
                  {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
                );
          if (opacity <= 0) {
            return null;
          }
          const local = Math.max(frame - start, 0);
          const driftT = interpolate(local, [0, per + XFADE], [0, 1], {
            extrapolateRight: 'clamp',
          });
          const isPhone = (sc.frame ?? 'browser') === 'phone';
          return (
            <div
              key={sc.src}
              style={{
                position: i === 0 ? 'relative' : 'absolute',
                inset: i === 0 ? undefined : 0,
                display: 'flex',
                justifyContent: 'center',
                opacity,
              }}
            >
              {isPhone ? (
                <PhoneFrame src={sc.src} height={phoneHeight} pan={driftT} />
              ) : (
                <BrowserFrame
                  src={sc.src}
                  url={sc.url}
                  width={fmt.screenWidth}
                  drift={interpolate(driftT, [0, 1], [1, 1.05])}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
