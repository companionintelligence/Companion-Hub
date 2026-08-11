import React from 'react';
import {GradientBackground} from '../components/GradientBackground';
import {ScreenCarousel, Screen} from '../components/ScreenCarousel';
import {CaptionBar} from '../components/CaptionBar';
import {IntroScene} from '../scenes/IntroScene';
import {DiagramScene} from '../scenes/DiagramScene';
import {Shot01Scene} from '../scenes/Shot01Scene';
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

/**
 * Scenes rendered in the "shot-01" treatment (illustrated device, text below
 * it) instead of the default carousel + lower-third. Scoped deliberately: the
 * rest of the film still uses `PhoneFrame`/`ScreenFrame`, so this list is the
 * whole blast radius of the format change.
 */
const SHOT01_SCENES = new Set(['c2-portal-signup']);

/** Maps one v2 scene to its on-screen visual + caption + gag. */
export const SceneRenderer: React.FC<{scene: V2Scene}> = ({scene}) => {
  // Unconditional — hooks cannot sit behind the shot-01 branch below.
  const fmt = useFormat();

  if (SHOT01_SCENES.has(scene.id) && scene.screens.length > 0) {
    // Each scene lists a browser shot and a phone shot; take the one this
    // format frames, falling back to the first if only one was captured.
    const want = fmt.isPortrait ? 'phone' : 'browser';
    const pick =
      scene.screens.find((s) => (s.frame ?? 'browser') === want) ?? scene.screens[0];
    return (
      <Shot01Scene
        src={`screens/${pick.shotId}.png`}
        url={pick.url}
        caption={scene.caption}
        step={stepFor(scene)}
      />
    );
  }

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
