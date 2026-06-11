import React from 'react';
import {GradientBackground} from '../components/GradientBackground';
import {ScreenCarousel, Screen} from '../components/ScreenCarousel';
import {CaptionBar} from '../components/CaptionBar';
import {IntroScene} from '../scenes/IntroScene';
import {DiagramScene} from '../scenes/DiagramScene';
import {OutroScene} from '../scenes/OutroScene';
import {TallyScene} from '../scenes/TallyScene';
import {SupportTicketStub} from '../components/gags/SupportTicketStub';
import {FinePrintAsterisk} from '../components/gags/FinePrintAsterisk';
import {PriceTag} from '../components/gags/PriceTag';
import {useFormat} from '../brand/format';
import {V2Scene, stepFor} from './scenes';

const toScreens = (scene: V2Scene): Screen[] =>
  scene.screens.map((s) => ({
    src: `screens/${s.shotId}.png`,
    url: s.url,
    frame: s.frame,
  }));

/** Per-scene gag overlay, keyed by scene id (booked chapter gags only). */
const GagOverlay: React.FC<{scene: V2Scene}> = ({scene}) => {
  const fmt = useFormat();
  switch (scene.id) {
    case 'c3-hub-controls':
      return <SupportTicketStub />;
    case 'c4-store-privacy':
      return <FinePrintAsterisk />;
    case 'c6-close-fleet':
      // the planted coral tag, dangling unexplained off the dashboard corner
      return (
        <PriceTag
          mode="plant"
          left={fmt.isPortrait ? fmt.w * 0.7 : fmt.w * 0.78}
          top={fmt.isPortrait ? fmt.h * 0.16 : fmt.h * 0.2}
        />
      );
    default:
      return null;
  }
};

/** Maps one v2 scene to its on-screen visual + caption + gag. */
export const SceneRenderer: React.FC<{scene: V2Scene}> = ({scene}) => {
  switch (scene.kind) {
    case 'intro':
      return <IntroScene tagline={scene.caption} />;

    case 'diagram':
      return (
        <DiagramScene
          caption={scene.caption}
          cloudJoke={scene.id === 'c1-open-cloud-joke'}
        />
      );

    case 'outro':
      return <OutroScene cta="Own your AI." url="ci.computer" />;

    case 'feature':
      // c6-close-tally is a screenless graphics beat (the ownership chips)
      if (scene.screens.length === 0) {
        return <TallyScene caption={scene.caption} step={stepFor(scene)} />;
      }
    // falls through to screen rendering when it has screens
    case 'screen':
    default:
      return (
        <GradientBackground>
          <ScreenCarousel screens={toScreens(scene)} />
          <GagOverlay scene={scene} />
          <CaptionBar caption={scene.caption} step={stepFor(scene)} />
        </GradientBackground>
      );
  }
};
