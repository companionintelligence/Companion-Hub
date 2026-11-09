import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './theme-provider';

function ThemeConsumer() {
  const { theme, setTheme } = useTheme();

  return (
    <>
      <span>{theme}</span>
      <button onClick={() => setTheme('dark')} type="button">
        Set dark
      </button>
    </>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('falls back to the default theme when localStorage reads fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByText('light')).toBeInTheDocument();
    expect(document.documentElement).toHaveClass('light');
  });

  it('keeps applying theme changes when localStorage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeConsumer />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set dark' }));

    expect(screen.getByText('dark')).toBeInTheDocument();
    expect(document.documentElement).toHaveClass('dark');
  });
});

describe('ThemeProvider following the computer', () => {
  /** Stands in for the browser's dark mode query, so a test can switch the computer's setting. */
  function stubComputerTheme(initiallyDark: boolean) {
    const listeners = new Set<() => void>();
    const query = {
      matches: initiallyDark,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal('matchMedia', () => query);
    return {
      listeners,
      switchTo(dark: boolean) {
        query.matches = dark;
        for (const listener of listeners) listener();
      },
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['dark to light', true, 'dark', 'light'],
    ['light to dark', false, 'light', 'dark'],
  ])('switches with the computer from %s without a reload', (_name, initiallyDark, first, second) => {
    const computer = stubComputerTheme(initiallyDark);

    render(
      <ThemeProvider defaultTheme="system">
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(document.documentElement).toHaveClass(first);

    computer.switchTo(!initiallyDark);

    expect(document.documentElement).toHaveClass(second);
    expect(document.documentElement).not.toHaveClass(first);
  });

  it('keeps a theme picked by hand when the computer changes', () => {
    const computer = stubComputerTheme(false);

    render(
      <ThemeProvider defaultTheme="system">
        <ThemeConsumer />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set dark' }));
    expect(document.documentElement).toHaveClass('dark');

    computer.switchTo(false);
    computer.switchTo(true);
    computer.switchTo(false);

    expect(document.documentElement).toHaveClass('dark');
    expect(computer.listeners.size).toBe(0);
  });
});
