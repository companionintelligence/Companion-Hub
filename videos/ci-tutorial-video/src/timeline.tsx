import React from 'react';
import {Audio, staticFile} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {IntroScene} from './scenes/IntroScene';
import {DiagramScene} from './scenes/DiagramScene';
import {ScreenScene} from './scenes/ScreenScene';
import {OutroScene} from './scenes/OutroScene';
import {VIDEO} from './brand/theme';
import type {Screen} from './components/ScreenCarousel';

const TRANSITION_FRAMES = 15;

export type Beat =
  | {kind: 'intro'; id: string; seconds: number; tagline: string; audio?: string}
  | {
      kind: 'diagram';
      id: string;
      seconds: number;
      title: string;
      caption: string;
      step?: string;
      audio?: string;
    }
  | {
      kind: 'screen';
      id: string;
      seconds: number;
      screens: Screen[];
      caption: string;
      step?: string;
      audio?: string;
    }
  | {kind: 'outro'; id: string; seconds: number; cta: string; url: string; audio?: string};

const shot = (id: string, url?: string): Screen => ({
  src: `screens/${id}.png`,
  url,
});

// Full cut generated from storyboard/scenes.json (13 scenes, ~185s).
// Screenshot files are placeholder slates until the per-shot capture
// agents replace them with real captures of the same filename.
export const BEATS: Beat[] = [
  {
    kind: 'intro',
    id: 's01-brand-intro',
    seconds: 8,
    tagline: 'Your data. Your hardware. Your AI.',
    audio: 'audio/s01-brand-intro.mp3',
  },
  {
    kind: 'diagram',
    id: 's02-platform-diagram',
    seconds: 18,
    title: 'The Companion Intelligence platform',
    caption: 'Three pieces. One private platform.',
    step: 'Overview',
    audio: 'audio/s02-platform-diagram.mp3',
  },
  {
    kind: 'screen',
    id: 's03-portal-signup',
    seconds: 16,
    screens: [
      shot('portal-signup', 'hub.ci.computer/signup'),
      shot('portal-login', 'hub.ci.computer/login'),
    ],
    caption: 'hub.ci.computer — create a free account',
    step: '01 · Portal',
    audio: 'audio/s03-portal-signup.mp3',
  },
  {
    kind: 'screen',
    id: 's04-portal-workspace-add-device',
    seconds: 18,
    screens: [
      shot('portal-home', 'hub.ci.computer/home'),
      shot('portal-add-device-dialog', 'hub.ci.computer/home'),
    ],
    caption: 'One dashboard for every device you own',
    step: '02 · Portal',
    audio: 'audio/s04-portal-workspace-add-device.mp3',
  },
  {
    kind: 'screen',
    id: 's05-portal-pairing-code',
    seconds: 12,
    screens: [shot('portal-pairing-code-dialog', 'hub.ci.computer/home')],
    caption: 'One code claims your Hub',
    step: '03 · Portal',
    audio: 'audio/s05-portal-pairing-code.mp3',
  },
  {
    kind: 'screen',
    id: 's06-hub-device-registration',
    seconds: 16,
    screens: [
      shot('hub-device-registration-empty', 'your-hub.local/device-registration'),
      shot('hub-device-registration-provisioning', 'your-hub.local/device-registration'),
      shot('hub-device-registration-complete', 'your-hub.local/device-registration'),
    ],
    caption: 'Enter the code on your Hub',
    step: '04 · Hub',
    audio: 'audio/s06-hub-device-registration.mp3',
  },
  {
    kind: 'screen',
    id: 's07-hub-onboarding',
    seconds: 16,
    screens: [
      shot('hub-onboarding-form', 'your-hub.local/onboarding'),
      shot('hub-onboarding-installing', 'your-hub.local/onboarding'),
    ],
    caption: 'Local AI, configured in one pass',
    step: '05 · Hub',
    audio: 'audio/s07-hub-onboarding.mp3',
  },
  {
    kind: 'screen',
    id: 's08-hub-home-dashboard',
    seconds: 14,
    screens: [shot('hub-home-dashboard', 'your-hub.local/home')],
    caption: 'Running on your machine — and you can see it',
    step: '06 · Hub',
    audio: 'audio/s08-hub-home-dashboard.mp3',
  },
  {
    kind: 'screen',
    id: 's09-store-browse',
    seconds: 18,
    screens: [
      shot('hub-store-grid', 'your-hub.local/store'),
      shot('hub-store-ci-category', 'your-hub.local/store'),
    ],
    caption: '200+ self-hosted apps, one click away',
    step: '07 · App Store',
    audio: 'audio/s09-store-browse.mp3',
  },
  {
    kind: 'screen',
    id: 's10-install-lifecycle',
    seconds: 20,
    screens: [
      shot('hub-app-details-immich', 'your-hub.local/store/immich'),
      shot('hub-install-dialog-immich', 'your-hub.local/store/immich'),
      shot('hub-app-installing-immich', 'your-hub.local/apps/immich'),
      shot('hub-app-running-immich', 'your-hub.local/apps/immich'),
    ],
    caption: 'installing → starting → running',
    step: '08 · Install',
    audio: 'audio/s10-install-lifecycle.mp3',
  },
  {
    kind: 'screen',
    id: 's11-app-live',
    seconds: 12,
    screens: [shot('app-immich-live', 'immich-living-room.ci.computer')],
    caption: 'Your photos. Your server. No subscription.',
    step: '09 · Your apps',
    audio: 'audio/s11-app-live.mp3',
  },
  {
    kind: 'screen',
    id: 's12-portal-fleet',
    seconds: 12,
    screens: [shot('portal-home-with-device', 'hub.ci.computer/home')],
    caption: 'Every device, every app — one quiet dashboard',
    step: '10 · Portal',
    audio: 'audio/s12-portal-fleet.mp3',
  },
  {
    kind: 'outro',
    id: 's13-outro',
    seconds: 5,
    cta: 'Own your AI.',
    url: 'ci.computer',
    audio: 'audio/s13-outro.mp3',
  },
];

const frames = (s: number) => Math.round(s * VIDEO.fps);

export const tourDurationInFrames = (beats: Beat[] = BEATS): number => {
  const scenes = beats.reduce((sum, b) => sum + frames(b.seconds), 0);
  return scenes - TRANSITION_FRAMES * (beats.length - 1);
};

const renderBeat = (b: Beat): React.ReactElement => {
  switch (b.kind) {
    case 'intro':
      return <IntroScene tagline={b.tagline} />;
    case 'diagram':
      return <DiagramScene title={b.title} caption={b.caption} step={b.step} />;
    case 'screen':
      return <ScreenScene screens={b.screens} caption={b.caption} step={b.step} />;
    case 'outro':
      return <OutroScene cta={b.cta} url={b.url} />;
  }
};

export const Tour: React.FC<{beats?: Beat[]}> = ({beats = BEATS}) => (
  <TransitionSeries>
    {beats.flatMap((b, i) => {
      const seq = (
        <TransitionSeries.Sequence
          key={`s-${b.id}`}
          durationInFrames={frames(b.seconds)}
        >
          {b.audio ? <Audio src={staticFile(b.audio)} /> : null}
          {renderBeat(b)}
        </TransitionSeries.Sequence>
      );
      if (i === beats.length - 1) {
        return [seq];
      }
      return [
        seq,
        <TransitionSeries.Transition
          key={`t-${b.id}`}
          presentation={fade()}
          timing={linearTiming({durationInFrames: TRANSITION_FRAMES})}
        />,
      ];
    })}
  </TransitionSeries>
);
