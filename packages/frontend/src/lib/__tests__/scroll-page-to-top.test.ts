import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollPageToTop } from '../scroll-page-to-top';

// jsdom has no Element.scrollTo and does no layout. Record the calls and apply
// the offset so the tests can read where each scroller ended up.
const scrollToCalls: { element: Element; options: ScrollToOptions }[] = [];

function element(tag: string, attributes: Record<string, string> = {}, children: HTMLElement[] = []) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  el.append(...children);
  return el;
}

function prefersReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: matches && query === '(prefers-reduced-motion: reduce)' })),
  );
}

describe('scrollPageToTop', () => {
  beforeEach(() => {
    scrollToCalls.length = 0;
    Element.prototype.scrollTo = function scrollTo(this: Element, options?: ScrollToOptions | number) {
      if (typeof options !== 'object') throw new Error('expected options');
      scrollToCalls.push({ element: this, options });
    } as Element['scrollTo'];
    prefersReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore jsdom's prototype, which has no scrollTo.
    delete (Element.prototype as Partial<Element>).scrollTo;
  });

  it("scrolls the layout and the current page's panes, not the page animating out", () => {
    const storePane = element('div', { 'data-page-scroller': 'store' });
    const storeSidebar = element('div', { 'data-page-scroller': 'sidebar' });
    const leavingPane = element('div', { 'data-page-scroller': 'store' });
    const layout = element('main', {}, [
      element('div', { 'data-page-key': '/home' }, [leavingPane]),
      element('div', { 'data-page-key': '/store' }, [storeSidebar, storePane]),
    ]);

    scrollPageToTop(layout, '/store');

    expect(scrollToCalls.map((call) => call.element)).toEqual([layout, storeSidebar, storePane]);
    for (const call of scrollToCalls) expect(call.options).toEqual({ top: 0, behavior: 'smooth' });
  });

  it('jumps instead of animating when the user asks for reduced motion', () => {
    prefersReducedMotion(true);
    const pane = element('div', { 'data-page-scroller': 'store' });
    const layout = element('main', {}, [element('div', { 'data-page-key': '/store' }, [pane])]);

    scrollPageToTop(layout, '/store');

    expect(scrollToCalls.map((call) => call.options.behavior)).toEqual(['auto', 'auto']);
  });
});
