import { useResolvedTheme } from '@/lib/use-resolved-theme';
import { LetItGo } from 'let-it-go';
import { useEffect } from 'react';

// Over the page's solid background but under the media gallery (z-40), the header and dialogs (z-50).
// The canvas covers the whole window at this height, so it must never take a click.
const SNOW_STYLE = { zIndex: '30', pointerEvents: 'none' } as const;

export const ChristmasTheme = () => {
  const resolvedTheme = useResolvedTheme();

  // Plain white flakes vanish on the light theme, so they take the theme's own colour.
  // Under reduced motion the library paints once and never repaints for a new colour, so each theme gets new snow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token's value changes with the theme, so the theme is what re-runs this.
  useEffect(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    const snow = new LetItGo({ number: 60, radiusRange: [1, 2], alphaRange: [0.4, 0.8], color, style: SNOW_STYLE });

    return () => snow.clear();
  }, [resolvedTheme]);

  return null;
};
