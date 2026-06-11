import React from 'react';
import {Composition} from 'remotion';
import {BEATS, Tour, tourDurationInFrames} from './timeline';
import {TourV2, totalFrames, teaserScenes} from './v2/timeline';
import {VIDEO} from './brand/theme';

export const RemotionRoot: React.FC = () => (
  <>
    {/* v2 — the remake. Landscape (desktop-lead) and portrait (mobile-lead) from
        one timeline; every scene restages itself per format. */}
    <Composition
      id="CIPlatformTour"
      component={TourV2}
      durationInFrames={totalFrames()}
      fps={VIDEO.fps}
      width={1920}
      height={1080}
    />
    <Composition
      id="CIPlatformTourPortrait"
      component={TourV2}
      durationInFrames={totalFrames()}
      fps={VIDEO.fps}
      width={1080}
      height={1920}
    />
    <Composition
      id="CITeaserPortrait60"
      component={TourV2}
      defaultProps={{scenes: teaserScenes()}}
      durationInFrames={totalFrames(teaserScenes())}
      fps={VIDEO.fps}
      width={1080}
      height={1920}
    />

    {/* v1 — original landscape cut, kept for reference. */}
    <Composition
      id="CIPlatformTourV1"
      component={Tour}
      durationInFrames={tourDurationInFrames(BEATS)}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
  </>
);
