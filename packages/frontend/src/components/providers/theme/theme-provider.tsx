import { useUserContext } from '@/context/user-context';
import { useUIStore } from '@/stores/ui-store';
import Cookies from 'js-cookie';
import type React from 'react';
import { useEffect } from 'react';

type Props = {
  children: React.ReactNode;
  initialTheme?: string;
};

export const ThemeProvider = (props: Props) => {
  const { children, initialTheme } = props;
  const { themeBase, themeColor } = useUserContext();

  const theme = useUIStore((state) => state.theme);
  const setDarkMode = useUIStore((state) => state.setDarkMode);

  useEffect(() => {
    if (themeBase) {
      document.body.dataset.bsThemeBase = themeBase;
    }

    if (themeColor) {
      document.body.dataset.bsThemePrimary = themeColor;
    }

    if (theme) {
      Cookies.set('theme', theme || initialTheme || 'light', { path: '/', expires: 365 });
      document.body.dataset.bsTheme = theme;
      document.documentElement.classList.toggle('dark', theme === 'dark');
    } else if (!Cookies.get('theme')) {
      // Detect system theme
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      setDarkMode(systemTheme === 'dark');
      Cookies.set('theme', systemTheme, { path: '/', expires: 365 });
      document.body.dataset.bsTheme = systemTheme;
      document.documentElement.classList.toggle('dark', systemTheme === 'dark');
    }

    const cookieTheme = Cookies.get('theme');
    setDarkMode(cookieTheme === 'dark');
  }, [initialTheme, setDarkMode, theme, themeBase, themeColor]);

  return children;
};
