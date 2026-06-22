import React from 'react';
import {Audio, staticFile} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {SceneRenderer} from './SceneRenderer';
import {SCENES, V2Scene} from './scenes';
import {VIDEO} from '../brand/theme';

const TRANSITION_FRAMES = 15;
const frames = (sec: number) => Math.round(sec * VIDEO.fps);

/** Optional per-scene second override (used by the teaser cut). */
export type SceneList = Array<V2Scene & {teaserSeconds?: number}>;

const secondsOf = (s: V2Scene & {teaserSeconds?: number}) =>
  s.teaserSeconds ?? s.durationInSeconds;

export const totalFrames = (list: SceneList = SCENES): number => {
  const sum = list.reduce((acc, s) => acc + frames(secondsOf(s)), 0);
  return sum - TRANSITION_FRAMES * (list.length - 1);
};

/**
 * The v2 master timeline — one component for BOTH the landscape (1920×1080) and
 * portrait (1080×1920) compositions; every scene reads useFormat and restages
 * itself. Each scene carries its own narration track.
 */
export const TourV2: React.FC<{scenes?: SceneList}> = ({scenes = SCENES}) => (
  <TransitionSeries>
    {scenes.flatMap((scene, i) => {
      const seq = (
        <TransitionSeries.Sequence
          key={`s-${scene.id}`}
          durationInFrames={frames(secondsOf(scene))}
        >
          <Audio src={staticFile(`audio/${scene.id}.mp3`)} />
          <SceneRenderer scene={scene} />
        </TransitionSeries.Sequence>
      );
      if (i === scenes.length - 1) return [seq];
      return [
        seq,
        <TransitionSeries.Transition
          key={`t-${scene.id}`}
          presentation={fade()}
          timing={linearTiming({durationInFrames: TRANSITION_FRAMES})}
        />,
      ];
    })}
  </TransitionSeries>
);

/** 60-second portrait teaser: a curated subset, some beats trimmed. */
const TEASER_IDS: Record<string, number | undefined> = {
  'c1-open-brand-intro': 5,
  'c1-open-cloud-joke': 6,
  'c2-portal-pairing-code': 9,
  'c3-hub-claim': 9,
  'c4-store-privacy': 8,
  'c4-store-live': 9,
  'c6-close-tally': 7,
  'c6-close-outro': 6,
};

export const teaserScenes = (): SceneList =>
  SCENES.filter((s) => s.id in TEASER_IDS).map((s) => ({
    ...s,
    teaserSeconds: TEASER_IDS[s.id],
  }));
