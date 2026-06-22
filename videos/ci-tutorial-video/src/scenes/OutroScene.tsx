import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {GradientBackground} from '../components/GradientBackground';
import {CIBanner, CIMark} from '../components/CILogo';
import {color, font, gradient, radius} from '../brand/theme';
import {fontFamily} from '../brand/fonts';
import {s, useFormat} from '../brand/format';

export const OutroScene: React.FC<{cta: string; url: string}> = ({cta, url}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fmt = useFormat();
  const logo = spring({frame, fps, config: {damping: 200}, durationInFrames: 28});
  const text = spring({frame: frame - 16, fps, config: {damping: 200}, durationInFrames: 28});
  const chip = spring({frame: frame - 34, fps, config: {damping: 13, stiffness: 110}, durationInFrames: 35});
  // teal rule draws under the chip once it settles
  const rule = interpolate(frame, [46, 60], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <GradientBackground>
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          gap: s(fmt, 40),
          fontFamily,
        }}
      >
        <div
          style={{
            opacity: logo,
            transform: `translateY(${(1 - logo) * 24}px)`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: s(fmt, 24),
          }}
        >
          {fmt.isPortrait ? (
            <>
              <CIMark size={s(fmt, 170)} />
              <div
                style={{
                  color: color.text,
                  fontSize: s(fmt, 44),
                  fontWeight: font.weight.semibold,
                  letterSpacing: s(fmt, 5),
                  textTransform: 'uppercase',
                  textAlign: 'center',
                  lineHeight: 1.15,
                }}
              >
                Companion
                <br />
                Intelligence
              </div>
            </>
          ) : (
            <CIBanner height={120} />
          )}
        </div>
        <div
          style={{
            opacity: text,
            color: color.textSoft,
            fontSize: s(fmt, 40),
            fontWeight: font.weight.body,
            maxWidth: Math.min(1200, fmt.w - fmt.padX * 2),
            textAlign: 'center',
            lineHeight: 1.4,
          }}
        >
          {cta}
        </div>
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: s(fmt, 14)}}>
          <div
            style={{
              transform: `scale(${chip})`,
              background: gradient.button,
              border: '1px solid rgba(130,252,252,0.24)',
              borderRadius: radius.xl,
              padding: `${s(fmt, 24)}px ${s(fmt, 64)}px`,
              color: '#F7FEFF',
              fontSize: s(fmt, 42),
              fontWeight: font.weight.semibold,
              letterSpacing: 1,
              boxShadow: '0 0 60px rgba(130,255,255,0.3)',
            }}
          >
            {url}
          </div>
          <div
            style={{
              height: 3,
              width: s(fmt, 320) * rule,
              borderRadius: 2,
              background: `linear-gradient(90deg, ${color.mint}, ${color.cyanBright})`,
              opacity: rule,
            }}
          />
        </div>
      </AbsoluteFill>
    </GradientBackground>
  );
};
