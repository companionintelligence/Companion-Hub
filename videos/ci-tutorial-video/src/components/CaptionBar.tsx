import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {color, font, radius} from '../brand/theme';
import {fontFamily} from '../brand/fonts';
import {s, useFormat} from '../brand/format';

/**
 * Lower-third caption: mint accent bar + step badge + caption text.
 * Slides up on entry, fades near scene end. Orientation-aware — in portrait it
 * centers in a wider safe column and sits higher to clear the phone frame.
 */
export const CaptionBar: React.FC<{caption: string; step?: string}> = ({
  caption,
  step,
}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fmt = useFormat();

  const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: 20});
  const exit = interpolate(
    frame,
    [durationInFrames - 12, durationInFrames - 2],
    [1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: fmt.isPortrait ? 0 : fmt.padX,
        right: fmt.isPortrait ? 0 : undefined,
        bottom: fmt.captionBottom,
        display: 'flex',
        justifyContent: fmt.isPortrait ? 'center' : 'flex-start',
        alignItems: 'center',
        gap: s(fmt, 24),
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 40}px)`,
        fontFamily,
        paddingLeft: fmt.isPortrait ? fmt.padX : 0,
        paddingRight: fmt.isPortrait ? fmt.padX : 0,
      }}
    >
      <div
        style={{
          width: 6,
          alignSelf: 'stretch',
          borderRadius: 3,
          background: `linear-gradient(180deg, ${color.cyanBright}, ${color.mint})`,
          boxShadow: '0 0 24px rgba(88,235,191,0.45)',
        }}
      />
      <div
        style={{
          background: 'rgba(8,29,40,0.82)',
          border: `1px solid ${color.borderSoft}`,
          borderRadius: radius.xl,
          padding: `${s(fmt, 22)}px ${s(fmt, 36)}px`,
          maxWidth: fmt.isPortrait ? fmt.w - fmt.padX * 2 - 12 : 1100,
          backdropFilter: 'blur(8px)',
        }}
      >
        {step ? (
          <div
            style={{
              color: color.accent2,
              fontSize: s(fmt, 22),
              fontWeight: font.weight.semibold,
              letterSpacing: 3,
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            {step}
          </div>
        ) : null}
        <div
          style={{
            color: color.text,
            fontSize: s(fmt, fmt.isPortrait ? 38 : 34),
            fontWeight: font.weight.medium,
            lineHeight: 1.35,
          }}
        >
          {caption}
        </div>
      </div>
    </div>
  );
};
