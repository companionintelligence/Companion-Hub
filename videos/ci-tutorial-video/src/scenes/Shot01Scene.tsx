import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {GradientBackground} from '../components/GradientBackground';
import {Shot01Device} from '../components/Shot01Device';
import {fontFamily, letterSpacing, wordSpacing} from '../brand/fonts';
import {font} from '../brand/theme';
import {useFormat} from '../brand/format';
import {
  SHOT01,
  clamp01,
  easeInOutSine,
  easeOutCubic,
  easeOutQuint,
  shot01Geometry,
} from '../brand/shot01';

/**
 * The shot-01 treatment in the FILM: the illustrated device on the film's
 * ground, with the lower-third text. The device itself is `Shot01Device`, which
 * the standalone layer `HubCut01` also uses, so the two cannot drift.
 *
 * Ported from `graphic-frames/import-tools-v2/src/build.mjs`.
 *
 * WHAT IS AND IS NOT PORTED
 * The reference cross-fades ten full-page plates so tiles light up as they cross
 * the middle of the screen — the app's own `.picked` styling, captured per
 * state, not an overlay. That choreography is inseparable from its subject: a
 * long scrollable list. Faking it on a screen that has no such states would be,
 * in the reference's own words, "a picture of a product state that never
 * existed".
 */
export const Shot01Scene: React.FC<{
  /** Path under public/, e.g. "screens/portal-signup.png". */
  src: string;
  caption: string;
  step?: string;
  url?: string;
}> = ({src, caption, step, url}) => {
  const frame = useCurrentFrame();
  // Inside a <Sequence> these are the SCENE's frame and length, not the film's.
  const {fps, durationInFrames} = useVideoConfig();
  const fmt = useFormat();
  const t = frame / fps;

  const P = SHOT01.portrait;
  const L = SHOT01.landscape;
  const {devW, devH, restX, restY} = shot01Geometry(fmt);

  // --- the arrival. Decelerating, so it settles rather than stopping dead.
  const slide = easeOutQuint(clamp01(t / SHOT01.timing.slideEnd));

  // --- the text, only once the device has landed.
  const textIn = easeOutCubic(
    clamp01((t - SHOT01.timing.slideEnd) / SHOT01.timing.textFade),
  );

  // --- the page. Still until the device lands, then a slow eased read.
  const window_ = Math.max(0, durationInFrames / fps - SHOT01.timing.slideEnd);
  const scroll = easeInOutSine(
    clamp01(window_ > 0 ? (t - SHOT01.timing.slideEnd) / window_ : 0),
  );

  return (
    <GradientBackground>
      <Shot01Device fmt={fmt} src={src} url={url} slide={slide} scroll={scroll} />

      {/* Portrait aligns the text to the DEVICE's left edge; landscape to the
          frame's safe margin. Both are what the reference does. */}
      <div
        style={{
          position: 'absolute',
          left: fmt.isPortrait ? restX : 80,
          top: fmt.isPortrait ? restY + devH + P.textGap : undefined,
          bottom: fmt.isPortrait ? undefined : L.captionBottom,
          width: fmt.isPortrait ? devW : fmt.w - 160,
          opacity: textIn,
          transform: `translateY(${(18 * (1 - textIn)).toFixed(2)}px)`,
          fontFamily,
          // The reference sets these on <body>; the film sets fontFamily per
          // component, so the tracking rides with the text block that needs it.
          letterSpacing,
          wordSpacing,
          textShadow: '0 2px 18px rgba(4,22,32,0.9)',
        }}
      >
        {fmt.isPortrait ? (
          <>
            <div
              style={{
                fontSize: P.titleSize,
                fontWeight: font.weight.semibold,
                lineHeight: 1.02,
                letterSpacing: '-0.01em',
                color: SHOT01.text,
              }}
            >
              {caption}
            </div>
            {step ? (
              <div
                style={{
                  marginTop: 6,
                  fontSize: P.subSize,
                  fontWeight: font.weight.medium,
                  lineHeight: 1.12,
                  color: SHOT01.textMuted,
                }}
              >
                {step}
              </div>
            ) : null}
          </>
        ) : (
          <>
            {step ? (
              <div
                style={{
                  fontSize: L.stepSize,
                  fontWeight: font.weight.semibold,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: SHOT01.step,
                  marginBottom: 12,
                }}
              >
                {step}
              </div>
            ) : null}
            <div style={{fontSize: L.captionSize, color: SHOT01.text}}>{caption}</div>
          </>
        )}
      </div>
    </GradientBackground>
  );
};
