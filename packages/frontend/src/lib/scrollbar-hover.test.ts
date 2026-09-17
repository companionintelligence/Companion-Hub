import { afterEach, describe, expect, it } from 'vitest';
import { installScrollbarHover } from './scrollbar-hover';

// jsdom does no layout: give a scroller the geometry of a 300x500 box with a
// 12px vertical scrollbar at its right edge (x 288-300) and taller content.
function scroller({ scrollbar = 12, scrollHeight = 2000 } = {}) {
  const el = document.createElement('div');
  const define = (name: string, value: number) => Object.defineProperty(el, name, { configurable: true, value });
  define('offsetWidth', 300);
  define('clientWidth', 300 - scrollbar);
  define('clientLeft', 0);
  define('clientHeight', 500);
  define('scrollHeight', scrollHeight);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500, x: 0, y: 0, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

const pointerMove = (target: Element, clientX: number, clientY = 250) =>
  target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY }));

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  document.body.replaceChildren();
});

describe('installScrollbarHover', () => {
  it('marks a scroller while the pointer is over its scrollbar, anywhere along the track', () => {
    uninstall = installScrollbarHover();
    const el = scroller();

    pointerMove(el, 294, 480);
    expect(el).toHaveAttribute('data-scrollbar-hover');

    pointerMove(el, 150);
    expect(el).not.toHaveAttribute('data-scrollbar-hover');
  });

  it('moves the mark to the scroller under the pointer', () => {
    uninstall = installScrollbarHover();
    const first = scroller();
    const second = scroller();

    pointerMove(first, 294);
    pointerMove(second, 294);

    expect(first).not.toHaveAttribute('data-scrollbar-hover');
    expect(second).toHaveAttribute('data-scrollbar-hover');
  });

  it('ignores elements without a scrollbar or with nothing to scroll', () => {
    uninstall = installScrollbarHover();
    const overlay = scroller({ scrollbar: 0 });
    const short = scroller({ scrollHeight: 500 });

    pointerMove(overlay, 300);
    expect(overlay).not.toHaveAttribute('data-scrollbar-hover');

    pointerMove(short, 294);
    expect(short).not.toHaveAttribute('data-scrollbar-hover');
  });

  it('clears the mark when the pointer leaves the page', () => {
    uninstall = installScrollbarHover();
    const el = scroller();

    pointerMove(el, 294);
    document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));

    expect(el).not.toHaveAttribute('data-scrollbar-hover');
  });

  it('stops listening and clears the mark when uninstalled', () => {
    const stop = installScrollbarHover();
    const el = scroller();
    pointerMove(el, 294);

    stop();
    expect(el).not.toHaveAttribute('data-scrollbar-hover');

    pointerMove(el, 294);
    expect(el).not.toHaveAttribute('data-scrollbar-hover');
  });
});
