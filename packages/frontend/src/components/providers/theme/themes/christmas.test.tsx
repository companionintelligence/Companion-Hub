import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChristmasTheme } from './christmas';

const snow = vi.hoisted(() => ({
  instances: [] as { options: { color?: string; style?: { zIndex?: string; pointerEvents?: string } }; clear: ReturnType<typeof vi.fn> }[],
}));

vi.mock('let-it-go', () => ({
  LetItGo: class {
    options: unknown;
    clear = vi.fn();
    constructor(options: unknown) {
      this.options = options;
      snow.instances.push(this as never);
    }
  },
}));

/** The one snow instance a render makes. */
function theSnow() {
  const instance = snow.instances[0];
  if (!instance) throw new Error('no snow was created');
  return instance;
}

describe('ChristmasTheme', () => {
  beforeEach(() => {
    snow.instances.length = 0;
    document.documentElement.className = 'dark';
    document.documentElement.style.setProperty('--primary', '#c5e8dc');
  });

  afterEach(() => {
    document.documentElement.className = '';
    document.documentElement.style.removeProperty('--primary');
  });

  it('draws the snow above the page background, which hides a canvas at the default z-index of -1', () => {
    render(<ChristmasTheme />);

    expect(Number(theSnow().options.style?.zIndex)).toBeGreaterThan(0);
  });

  it('never takes a click, because the canvas covers the whole page', () => {
    render(<ChristmasTheme />);

    expect(theSnow().options.style?.pointerEvents).toBe('none');
  });

  // Under reduced motion the snow paints once, so a colour set after it's created would never show.
  it('creates the snow in the theme colour and replaces it on a change of theme', async () => {
    render(<ChristmasTheme />);
    expect(theSnow().options.color).toBe('#c5e8dc');

    act(() => {
      document.documentElement.style.setProperty('--primary', '#0a6358');
      document.documentElement.className = 'light';
    });

    await waitFor(() => expect(snow.instances[1]?.options.color).toBe('#0a6358'));
    expect(theSnow().clear).toHaveBeenCalledTimes(1);
  });

  it('removes the snow when it goes away', () => {
    const { unmount } = render(<ChristmasTheme />);

    unmount();

    expect(theSnow().clear).toHaveBeenCalledTimes(1);
  });
});
