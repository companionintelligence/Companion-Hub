import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePageScrollRestoration } from './use-page-scroll-restoration';

/**
 * The dashboard scrolls inside <main>, not the window, so React Router's
 * <ScrollRestoration /> never sees it. These tests drive real history
 * navigations through a memory router and check the scroller's offset.
 */

function Layout() {
  const ref = useRef<HTMLDivElement>(null);
  usePageScrollRestoration(ref);
  return (
    <div ref={ref} data-testid="scroller">
      <Outlet />
    </div>
  );
}

// jsdom does no layout, so scrollTop never clamps. Give the scroller a
// settable maximum so tests can model a page that is still loading.
function clampScroller(el: HTMLElement) {
  const state = { top: 0, max: 10_000 };
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = Math.max(0, Math.min(value, state.max));
      el.dispatchEvent(new Event('scroll'));
    },
  });
  return state;
}

function setup(initialEntry = '/store?category=all') {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/store', element: <p>list</p> },
          { path: '/store/:appId', element: <p>app</p> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const view = render(<RouterProvider router={router} />);
  const scroller = view.getByTestId('scroller');
  return { router, scroller, state: clampScroller(scroller) };
}

const scrollTo = (el: HTMLElement, top: number) => {
  el.scrollTop = top;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('usePageScrollRestoration', () => {
  it('opens a pushed page at the top', async () => {
    const { router, scroller } = setup();
    scrollTo(scroller, 900);

    await act(() => router.navigate('/store/app-1'));

    expect(scroller.scrollTop).toBe(0);
  });

  it('scrolls to the top when a replace changes the query', async () => {
    const { router, scroller } = setup();
    scrollTo(scroller, 900);

    await act(() => router.navigate('/store?category=ai', { replace: true }));

    expect(scroller.scrollTop).toBe(0);
  });

  it('leaves the offset alone when a replace keeps the same path and query', async () => {
    const { router, scroller } = setup();
    scrollTo(scroller, 900);

    await act(() => router.navigate('/store?category=all', { replace: true }));

    expect(scroller.scrollTop).toBe(900);
  });

  it('returns to the list offset on back and to the app offset on forward', async () => {
    const { router, scroller } = setup();
    scrollTo(scroller, 900);
    await act(() => router.navigate('/store/app-1'));
    scrollTo(scroller, 250);

    await act(() => router.navigate(-1));
    expect(scroller.scrollTop).toBe(900);

    await act(() => router.navigate(1));
    expect(scroller.scrollTop).toBe(250);
  });

  it('keeps restoring on back until the page is tall enough', async () => {
    const { router, scroller, state } = setup();
    scrollTo(scroller, 900);
    await act(() => router.navigate('/store/app-1'));

    state.max = 300; // the list is still loading when back lands
    await act(() => router.navigate(-1));
    expect(scroller.scrollTop).toBe(300);

    state.max = 5_000; // data arrives
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(scroller.scrollTop).toBe(900);
  });

  it('carries a pending restore across a same-URL replace', async () => {
    const { router, scroller, state } = setup();
    scrollTo(scroller, 900);
    await act(() => router.navigate('/store/app-1'));

    state.max = 300;
    await act(() => router.navigate(-1));
    // The store page re-syncs its URL right after mounting.
    await act(() => router.navigate('/store?category=all', { replace: true }));

    state.max = 5_000;
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(scroller.scrollTop).toBe(900);
  });

  it('stops restoring once the user scrolls', async () => {
    const { router, scroller, state } = setup();
    scrollTo(scroller, 900);
    await act(() => router.navigate('/store/app-1'));

    state.max = 300;
    await act(() => router.navigate(-1));
    scroller.dispatchEvent(new Event('wheel'));
    scrollTo(scroller, 120);

    state.max = 5_000;
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(scroller.scrollTop).toBe(120);
  });
});
