import { createContext, useContext, type ParentComponent } from 'solid-js';
import { createSignal, createEffect, onCleanup } from 'solid-js';

export type Theme = 'dark' | 'light' | 'system';

interface ThemeContextValue {
  theme: () => Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>();

const STORAGE_KEY = 'vite-ui-theme';

export const ThemeProvider: ParentComponent = (props) => {
  const [theme, setThemeSignal] = createSignal<Theme>((localStorage.getItem(STORAGE_KEY) as Theme) || 'system');

  const applyTheme = (t: Theme) => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (t === 'system') {
      const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(sys);
    } else {
      root.classList.add(t);
    }
  };

  createEffect(() => {
    applyTheme(theme());
  });

  // Listen for system theme changes when in system mode
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = () => {
    if (theme() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', listener);
  onCleanup(() => mq.removeEventListener('change', listener));

  const setTheme = (t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeSignal(t);
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{props.children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
};
