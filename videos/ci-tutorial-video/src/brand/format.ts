import {useVideoConfig} from 'remotion';

export type Orientation = 'landscape' | 'portrait';

/**
 * Orientation-aware layout helper. Components read this instead of hardcoding
 * 1920×1080 so the same scene renders correctly in both the landscape
 * (1920×1080) and portrait (1080×1920) compositions.
 */
export type Format = {
  orientation: Orientation;
  isPortrait: boolean;
  w: number;
  h: number;
  /** A single scalar for type/spacing — based on the short edge vs the 1080 baseline. */
  scale: number;
  /** Safe horizontal inset (captions, titles) scaled to the format. */
  padX: number;
  /** Width a browser-framed screenshot should occupy. */
  screenWidth: number;
  /** Bottom offset for the caption lower-third. */
  captionBottom: number;
};

export const useFormat = (): Format => {
  const {width, height} = useVideoConfig();
  const isPortrait = height > width;
  // Short edge drives type scale so text stays readable in portrait.
  const scale = Math.min(width, height) / 1080;

  return {
    orientation: isPortrait ? 'portrait' : 'landscape',
    isPortrait,
    w: width,
    h: height,
    scale,
    padX: isPortrait ? 64 : 80,
    // Portrait: a browser screenshot nearly fills the width; landscape: ~81%.
    screenWidth: isPortrait ? width - 120 : Math.min(1560, width * 0.81),
    captionBottom: isPortrait ? 180 : 64,
  };
};

/** Scale a landscape-tuned pixel value by the active format's short-edge ratio. */
export const s = (fmt: Format, px: number): number => Math.round(px * fmt.scale);
