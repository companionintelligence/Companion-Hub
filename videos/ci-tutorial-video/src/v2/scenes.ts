import data from '../../storyboard/v2/scenes-v2.json';

export type V2Kind = 'intro' | 'diagram' | 'screen' | 'feature' | 'outro';

export type V2Screen = {
  shotId: string;
  frame: 'browser' | 'phone';
  url?: string;
};

export type V2Scene = {
  id: string;
  chapter: string;
  kind: V2Kind;
  durationInSeconds: number;
  caption: string;
  narration: string;
  gag: string | null;
  screens: V2Screen[];
  motionNotes?: string;
  portraitNotes?: string;
};

export const META = (data as {meta: {title: string; fps: number}}).meta;
export const SCENES = (data as {scenes: V2Scene[]}).scenes;

/** Chapter → step-badge label + ordinal (shown on screen-walkthrough beats). */
export const CHAPTER: Record<string, {label: string; index: number}> = {
  'c1-open': {label: 'Overview', index: 0},
  'c2-portal': {label: 'Portal', index: 1},
  'c3-hub': {label: 'Hub', index: 2},
  'c4-store': {label: 'App Store', index: 3},
  'c5-mobile': {label: 'Mobile', index: 4},
  'c6-close': {label: 'Recap', index: 5},
};

export const stepFor = (scene: V2Scene): string | undefined => {
  if (scene.kind !== 'screen' && scene.kind !== 'feature') return undefined;
  const c = CHAPTER[scene.chapter];
  if (!c) return undefined;
  return `0${c.index} · ${c.label}`;
};
