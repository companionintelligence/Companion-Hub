import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {GradientBackground} from '../components/GradientBackground';
import {PlatformDiagram} from '../components/PlatformDiagram';
import {CaptionBar} from '../components/CaptionBar';
import {CloudJoke} from '../components/gags/CloudJoke';
import {color, font} from '../brand/theme';
import {fontFamily} from '../brand/fonts';
import {s, useFormat} from '../brand/format';

/**
 * Platform-map scene. `cloudJoke` turns on the deflating Terms-of-Service cloud
 * (cold-open beat c1-open-cloud-joke): the porch light brightens in answer and
 * Portal's "cloud" sub-label is swapped out while clouds are being mocked.
 */
export const DiagramScene: React.FC<{
  title?: string;
  caption: string;
  step?: string;
  cloudJoke?: boolean;
}> = ({title, caption, step, cloudJoke = false}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fmt = useFormat();
  const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: 25});

  // During the cloud beat the porch light brightens as the cloud deflates.
  const porch = cloudJoke
    ? interpolate(frame, [durationInFrames * 0.45, durationInFrames * 0.7], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;

  return (
    <GradientBackground>
      {title ? (
        <div
          style={{
            position: 'absolute',
            top: s(fmt, 72),
            width: '100%',
            textAlign: 'center',
            fontFamily,
            color: color.text,
            fontSize: s(fmt, fmt.isPortrait ? 46 : 54),
            fontWeight: font.weight.display,
            letterSpacing: 4,
            opacity: enter,
            padding: `0 ${fmt.padX}px`,
          }}
        >
          {title}
        </div>
      ) : null}
      <PlatformDiagram porch={porch} cloudWord={!cloudJoke} />
      {cloudJoke ? <CloudJoke /> : null}
      <CaptionBar caption={caption} step={step} />
    </GradientBackground>
  );
};
