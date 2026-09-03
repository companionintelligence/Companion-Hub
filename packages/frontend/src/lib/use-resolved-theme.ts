import { useEffect, useState } from 'react';
import type { LogTheme } from './log-ansi';

function readResolvedTheme(): LogTheme {
  if (typeof document === 'undefined') {
    return 'light';
  }

  const root = document.documentElement;

  if (root.classList.contains('dark')) {
    return 'dark';
  }

  if (root.classList.contains('light')) {
    return 'light';
  }

  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  return 'light';
}

export function useResolvedTheme(): LogTheme {
  const [resolvedTheme, setResolvedTheme] = useState<LogTheme>(() => readResolvedTheme());

  useEffect(() => {
    const updateTheme = () => setResolvedTheme(readResolvedTheme());

    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const mediaQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    mediaQuery?.addEventListener('change', updateTheme);

    return () => {
      observer.disconnect();
      mediaQuery?.removeEventListener('change', updateTheme);
    };
  }, []);

  return resolvedTheme;
}
