import React from 'react';
import {GradientBackground} from '../components/GradientBackground';
import {Screen, ScreenCarousel} from '../components/ScreenCarousel';
import {CaptionBar} from '../components/CaptionBar';

/** A product-screen walkthrough beat: framed screenshot(s) + lower-third caption. */
export const ScreenScene: React.FC<{
  screens: Screen[];
  caption: string;
  step?: string;
}> = ({screens, caption, step}) => (
  <GradientBackground>
    <ScreenCarousel screens={screens} />
    <CaptionBar caption={caption} step={step} />
  </GradientBackground>
);
