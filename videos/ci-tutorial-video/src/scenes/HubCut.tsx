import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {useFormat} from '../brand/format';
import {Shot01Device} from '../components/Shot01Device';
import {SHOT01, clamp01, easeInOutSine, easeOutQuint} from '../brand/shot01';
import {Cut, plateFor, PLATE_OVERRIDE} from '../cuts/cuts';
import {WorkspaceScreen} from '../components/WorkspaceScreen';
import {AppDetailScreen, StoreCategoryScreen} from '../components/StoreScreens';
import {CHOREOGRAPHY, onboardingBar} from '../cuts/choreography';

/**
 * One cut — the illustrated device and its screen, as a COMPOSITING LAYER.
 *
 * No background, no caption, no narration: this renders on transparency so it
 * can be dropped over any ground, like the layers in
 * `graphic-frames/import-sources`. Anything opinionated — the ground, the
 * glows, the lower third, the voice — belongs to the layer it is composited
 * onto, not to this one.
 *
 * MOTION
 *   The device MOVES ONLY IN THE FIRST CUT, where it slides in from off-frame
 *   left and settles by 1.40s. In every other cut it is already at rest and its
 *   transform is constant, so the device is pixel-identical from the first
 *   frame of cut 02 to the last frame of cut 19. That is what makes the joins
 *   invisible: nothing about the device changes across a cut boundary, only
 *   what is inside it.
 *
 *   The page scrolls top to bottom on easeInOutSine for the whole cut (or from
 *   1.40s in the first), opening and closing gently rather than starting and
 *   stopping. A cut that continues the previous cut's page opens on exactly the
 *   scroll position that one closed at — see `Cut.from`.
 */
export const HubCut: React.FC<{cut: Cut}> = ({cut}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fmt = useFormat();
  const t = frame / fps;

  // The device arrives only in the first cut; elsewhere it is already at rest.
  const slide = cut.enters
    ? easeOutQuint(clamp01(t / SHOT01.timing.slideEnd))
    : 1;

  // The page waits for the device only when there is an arrival to wait for.
  const start = cut.enters ? SHOT01.timing.slideEnd : 0;
  const window_ = Math.max(0, durationInFrames / fps - start);
  // `speed` compresses the travel window; the page then holds where it landed.
  const progress = easeInOutSine(
    clamp01(window_ > 0 ? ((t - start) * cut.speed) / window_ : 0),
  );
  const scroll = cut.from + (cut.to - cut.from) * progress;

  const screen = fmt.isPortrait ? cut.portrait : cut.landscape;

  // A composed screen replaces the plate entirely — see WorkspaceScreen for why
  // this one cannot be photographed.
  // Screens rebuilt in Remotion rather than photographed. Each is here because
  // a capture cannot express what the beat needs: apps removed from a list, a
  // store listing the page never showed, or a mid-install state.
  const COMPOSED = new Set([
    'c2-portal-workspace',
    'c4-store-exclusives',
    'c4-store-privacy',
    'c4-store-lifecycle',
  ]);
  const composed = COMPOSED.has(cut.sceneId);
  const designW = fmt.isPortrait ? 450 : 1600;
  const choreo = CHOREOGRAPHY[cut.sceneId];

  return (
    <Shot01Device
      fmt={fmt}
      src={
        PLATE_OVERRIDE[cut.sceneId]
          ? `screens/${PLATE_OVERRIDE[cut.sceneId]}.png`
          : plateFor(screen)
      }
      url={screen.url}
      slide={slide}
      scroll={scroll}
      travels={cut.to > cut.from}
      overlay={choreo ? ({k}) => choreo({t, k, isPortrait: fmt.isPortrait}) : undefined}
      pinned={
        cut.sceneId === 'c3-hub-onboarding'
          ? ({apertureW, apertureH}) =>
              onboardingBar({apertureW, apertureH, isPortrait: fmt.isPortrait})
          : undefined
      }
      contentWidth={composed ? designW : undefined}
      content={
        composed
          ? ({width, height}) => {
              const common = {width, height, isPortrait: fmt.isPortrait};
              if (cut.sceneId === 'c2-portal-workspace') return <WorkspaceScreen {...common} />;
              if (cut.sceneId === 'c4-store-exclusives') {
                // "Companion Intelligence" typed into the search box, then held.
                const TYPE_FROM = 1.2;
                const TYPE_TO = 3.6;
                const q = 'Companion Intelligence';
                const n = Math.round(
                  q.length * clamp01((t - TYPE_FROM) / (TYPE_TO - TYPE_FROM)),
                );
                return (
                  <StoreCategoryScreen
                    {...common}
                    search={q.slice(0, n)}
                    caret={t >= TYPE_FROM && Math.floor(t * 2) % 2 === 0}
                  />
                );
              }
              if (cut.sceneId === 'c4-store-privacy')
                return <AppDetailScreen {...common} state="idle" />;
              // c4-store-lifecycle — the installing state, running to ~98%.
              return (
                <AppDetailScreen
                  {...common}
                  state="installing"
                  progress={clamp01((t - 0.8) / (durationInFrames / fps - 1.6)) * 0.98}
                />
              );
            }
          : undefined
      }
    />
  );
};
