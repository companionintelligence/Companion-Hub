import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
