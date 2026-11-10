import { syncTauriWindowBackground } from '@/lib/tauri-window-theme';
import { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

function readStoredTheme(storageKey: string, defaultTheme: Theme): Theme {
  if (typeof window === 'undefined') return defaultTheme;

  try {
    const stored = localStorage.getItem(storageKey) as Theme | null;
    return stored ?? defaultTheme;
  } catch {
    return defaultTheme;
  }
}

export function ThemeProvider({ children, defaultTheme = 'system', storageKey = 'vite-ui-theme' }: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme(storageKey, defaultTheme));

  useEffect(() => {
    const root = window.document.documentElement;

    const applyTheme = (resolvedTheme: 'dark' | 'light') => {
      root.classList.remove('light', 'dark');
      root.classList.add(resolvedTheme);
      void syncTauriWindowBackground();
    };

    if (theme !== 'system') {
      applyTheme(theme);
      return;
    }

    // A theme picked by hand doesn't get this listener, so it stays put when the computer changes.
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
    const applySystemTheme = () => applyTheme(systemDark.matches ? 'dark' : 'light');

    applySystemTheme();
    systemDark.addEventListener('change', applySystemTheme);

    return () => systemDark.removeEventListener('change', applySystemTheme);
  }, [theme]);

  const value = {
    theme,
    setTheme: (nextTheme: Theme) => {
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(storageKey, nextTheme);
        } catch {
          // Ignore storage write failures so theme changes still apply in memory.
        }
      }
      setTheme(nextTheme);
    },
  };

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined) throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};
