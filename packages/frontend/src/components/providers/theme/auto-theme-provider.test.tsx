import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoThemeProvider } from './auto-theme-provider';

const state = vi.hoisted(() => ({ allowAutoThemes: true, theme: 'christmas' as 'christmas' | 'default' }));

vi.mock('@/context/user-context', () => ({ useUserContext: () => ({ allowAutoThemes: state.allowAutoThemes }) }));
vi.mock('@/lib/theme/theme', () => ({ getAutoTheme: () => state.theme }));
vi.mock('./themes/christmas', () => ({
  ChristmasTheme: () => <div data-testid="snow" />,
}));

let pageMounts = 0;

function Page() {
  const mounted = useRef(false);
  if (!mounted.current) {
    mounted.current = true;
    pageMounts += 1;
  }
  return <span>Page</span>;
}

describe('AutoThemeProvider', () => {
  beforeEach(() => {
    state.allowAutoThemes = true;
    state.theme = 'christmas';
    pageMounts = 0;
  });

  it('shows the snow in December when auto themes are allowed', async () => {
    render(
      <AutoThemeProvider>
        <Page />
      </AutoThemeProvider>,
    );

    expect(await screen.findByTestId('snow')).toBeInTheDocument();
    expect(screen.getByText('Page')).toBeInTheDocument();
  });

  it.each([
    ['auto themes are off', false, 'christmas'],
    ['it is not December', true, 'default'],
  ] as const)('shows no snow when %s', async (_name, allowAutoThemes, theme) => {
    state.allowAutoThemes = allowAutoThemes;
    state.theme = theme;

    render(
      <AutoThemeProvider>
        <Page />
      </AutoThemeProvider>,
    );
    // The theme is lazy, so without this wait it would be missing here even with the gate broken.
    await act(async () => {
      await import('./themes/christmas');
    });

    expect(screen.queryByTestId('snow')).not.toBeInTheDocument();
    expect(screen.getByText('Page')).toBeInTheDocument();
  });

  it('keeps the page mounted when the setting changes', async () => {
    const { rerender } = render(
      <AutoThemeProvider>
        <Page />
      </AutoThemeProvider>,
    );
    await screen.findByTestId('snow');

    state.allowAutoThemes = false;
    rerender(
      <AutoThemeProvider>
        <Page />
      </AutoThemeProvider>,
    );

    expect(screen.queryByTestId('snow')).not.toBeInTheDocument();
    expect(pageMounts).toBe(1);
  });
});
