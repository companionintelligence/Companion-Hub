import React from 'react';
import {Composition} from 'remotion';
import {BEATS, Tour, tourDurationInFrames} from './timeline';
import {TourV2, totalFrames, teaserScenes} from './v2/timeline';
import {HubCut} from './scenes/HubCut';
import {CUTS, compositionId} from './cuts/cuts';
import {VIDEO} from './brand/theme';

export const RemotionRoot: React.FC = () => (
  <>
    {/* Compositing layers for /cuts — device + screen only, rendered on
        transparency. No ground, no text, no audio: those belong to whatever
        this is composited onto. One pair per screen beat, generated from the
        cut list so the storyboard stays the single source of truth.

        Render with `--codec=prores --prores-profile=4444
        --pixel-format=yuva444p10le --image-format=png --muted`. All four
        matter: without the last two the file comes out yuv422p12le, with no
        alpha channel at all, and looks correct until it is composited. */}
    {CUTS.map((cut) => (
      <React.Fragment key={cut.id}>
        <Composition
          id={compositionId(cut.id, 'landscape')}
          component={HubCut}
          defaultProps={{cut}}
          durationInFrames={Math.round(cut.durationInSeconds * VIDEO.fps)}
          fps={VIDEO.fps}
          width={1920}
          height={1080}
        />
        <Composition
          id={compositionId(cut.id, 'portrait')}
          component={HubCut}
          defaultProps={{cut}}
          durationInFrames={Math.round(cut.durationInSeconds * VIDEO.fps)}
          fps={VIDEO.fps}
          width={1080}
          height={1920}
        />
      </React.Fragment>
    ))}

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
