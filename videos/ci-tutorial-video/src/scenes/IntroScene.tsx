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
import {color, font, gradient} from '../brand/theme';
import {fontFamily} from '../brand/fonts';
import {s, useFormat} from '../brand/format';

export const IntroScene: React.FC<{tagline: string}> = ({tagline}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fmt = useFormat();

  const orb = spring({frame, fps, config: {damping: 200}, durationInFrames: 30});
  const logo = spring({frame: frame - 18, fps, config: {damping: 200}, durationInFrames: 30});
  const tag = spring({frame: frame - 40, fps, config: {damping: 200}, durationInFrames: 30});
  const glow = interpolate(frame, [0, 60], [0.2, 0.6], {extrapolateRight: 'clamp'});

  return (
    <GradientBackground>
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily,
          gap: s(fmt, 44),
        }}
      >
        <div
          style={{
            position: 'absolute',
            width: s(fmt, 700),
            height: s(fmt, 700),
            borderRadius: s(fmt, 350),
            background: gradient.orb,
            filter: 'blur(140px)',
            opacity: glow * orb * 0.45,
          }}
        />
        <div
          style={{
            opacity: logo,
            transform: `translateY(${(1 - logo) * 30}px)`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: s(fmt, 28),
          }}
        >
          {fmt.isPortrait ? (
            <>
              <CIMark size={s(fmt, 220)} />
              <div
                style={{
                  color: color.text,
                  fontSize: s(fmt, 52),
                  fontWeight: font.weight.semibold,
                  letterSpacing: s(fmt, 6),
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
            <CIBanner height={150} />
          )}
        </div>
        <div
          style={{
            opacity: tag,
            transform: `translateY(${(1 - tag) * 24}px)`,
            color: color.textSoft,
            fontSize: s(fmt, fmt.isPortrait ? 38 : 44),
            fontWeight: font.weight.display,
            letterSpacing: s(fmt, 8),
            textTransform: 'uppercase',
            textAlign: 'center',
            maxWidth: fmt.w - fmt.padX * 2,
          }}
        >
          {tagline}
        </div>
      </AbsoluteFill>
    </GradientBackground>
  );
};
