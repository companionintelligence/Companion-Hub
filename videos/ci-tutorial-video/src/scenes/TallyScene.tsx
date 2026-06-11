import React from 'react';
import {AbsoluteFill, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {GradientBackground} from '../components/GradientBackground';
import {PriceTag} from '../components/gags/PriceTag';
import {CaptionBar} from '../components/CaptionBar';
import {color, font, radius} from '../brand/theme';
import {fontFamily} from '../brand/fonts';
import {s, useFormat} from '../brand/format';

const CHIPS = ['Your hardware', 'Your domain', 'Your data', '$0/month'];
const STAGGER = 14; // frames between chip pops

/**
 * c6-close-tally: four ownership chips pop in sequence (2×2 in landscape, a
 * column in portrait), each with a check tick. The fourth ("$0/month") lands
 * and releases the planted coral price tag, which floats off-frame. Then a held
 * beat of silence before the outro — the silence is the button.
 */
export const TallyScene: React.FC<{caption: string; step?: string}> = ({
  caption,
  step,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fmt = useFormat();

  const fourthAt = CHIPS.length * STAGGER; // when "$0/month" settles → release tag

  const cols = fmt.isPortrait ? 1 : 2;
  const chipW = fmt.isPortrait ? Math.min(620, fmt.w - fmt.padX * 2) : 460;

  return (
    <GradientBackground>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', fontFamily}}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, ${chipW}px)`,
            gap: s(fmt, 22),
            transform: `translateY(${fmt.isPortrait ? -s(fmt, 60) : 0}px)`,
          }}
        >
          {CHIPS.map((label, i) => {
            const pop = spring({
              frame: frame - i * STAGGER,
              fps,
              config: {damping: 16, stiffness: 120},
              durationInFrames: 24,
            });
            const isZero = label === '$0/month';
            return (
              <div
                key={label}
                style={{
                  transform: `scale(${pop})`,
                  opacity: pop,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  background: color.card,
                  border: `1.5px solid ${isZero ? color.accent2 : color.border}`,
                  borderRadius: radius.xl,
                  padding: `${s(fmt, 20)}px ${s(fmt, 28)}px`,
                  boxShadow: isZero ? '0 0 50px rgba(25,198,200,0.22)' : 'none',
                }}
              >
                <CheckTick delay={i * STAGGER + 8} />
                <span
                  style={{
                    color: isZero ? color.accent : color.text,
                    fontSize: s(fmt, 34),
                    fontWeight: font.weight.semibold,
                  }}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>

      <PriceTag
        mode="unhook"
        left={fmt.isPortrait ? fmt.w * 0.7 : fmt.w * 0.66}
        top={fmt.isPortrait ? fmt.h * 0.2 : fmt.h * 0.26}
        releaseAt={fourthAt}
      />

      <CaptionBar caption={caption} step={step} />
    </GradientBackground>
  );
};

const CheckTick: React.FC<{delay: number}> = ({delay}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const draw = spring({frame: frame - delay, fps, config: {damping: 200}, durationInFrames: 12});
  return (
    <svg width={30} height={30} viewBox="0 0 30 30">
      <circle cx="15" cy="15" r="13" fill="none" stroke={color.mint} strokeWidth="2" opacity={0.5} />
      <path
        d="M9 15 l4 4 l8 -9"
        fill="none"
        stroke={color.mint}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={22}
        strokeDashoffset={22 * (1 - draw)}
      />
    </svg>
  );
};
