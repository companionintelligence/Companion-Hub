import { useResolvedTheme } from '@/lib/use-resolved-theme';
import { LetItGo } from 'let-it-go';
import { useEffect, useRef } from 'react';

// Above the page, which paints its own solid background, and below the header and dialogs (z-50).
const SNOW_Z_INDEX = '40';

export const ChristmasTheme = () => {
  const resolvedTheme = useResolvedTheme();
  const snowRef = useRef<LetItGo | null>(null);

  useEffect(() => {
    const snow = new LetItGo({ number: 60, radiusRange: [1, 2], alphaRange: [0.4, 0.8], style: { zIndex: SNOW_Z_INDEX } });
    snowRef.current = snow;

    return () => {
      snow.clear();
      snowRef.current = null;
    };
  }, []);

  // Plain white flakes vanish on the light theme, so they take the theme's own colour.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token's value changes with the theme, so the theme is what re-runs this.
  useEffect(() => {
    if (snowRef.current) {
      snowRef.current.color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    }
  }, [resolvedTheme]);

  return null;
};
