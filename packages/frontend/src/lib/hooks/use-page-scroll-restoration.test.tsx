import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { Outlet, RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usePageScrollRestoration } from './use-page-scroll-restoration';

/**
 * Dashboard pages scroll inside the layout's <main> or inside their own panes,
 * not the window, so React Router's <ScrollRestoration /> never sees them.
 * These tests drive real history navigations through a memory router and check
 * the scrollers' offsets.
 */

// jsdom does no layout, so scrollTop never clamps and never fires a scroll
// event. Model both, with a settable maximum per element so tests can have a
// page that is still loading.
const scrollModel = new WeakMap<Element, { top: number; max: number }>();
const modelOf = (el: Element) => {
  let model = scrollModel.get(el);
  if (!model) {
    model = { top: 0, max: 10_000 };
    scrollModel.set(el, model);
  }
  return model;
};
const nativeScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return modelOf(this).top;
    },
    set(this: Element, value: number) {
      const model = modelOf(this);
      const top = Math.max(0, Math.min(value, model.max));
      if (top === model.top) return;
      model.top = top;
      this.dispatchEvent(new Event('scroll'));
    },
  });
});

afterAll(() => {
  if (nativeScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', nativeScrollTop);
});

const scrollTo = (el: HTMLElement, top: number) => {
  el.scrollTop = top;
};

const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

// A layout that scrolls itself, like <main> for pages without their own pane.
function Layout() {
  const ref = useRef<HTMLDivElement>(null);
  usePageScrollRestoration(ref, 'page');
  return (
    <div ref={ref} data-testid="scroller">
      <Outlet />
    </div>
  );
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
  return { router, scroller, model: modelOf(scroller) };
}

// A layout like the dashboard's: pages render in a wrapper keyed by page, and
// scroll in their own marked panes. `leaving` adds the wrapper of a page that
// is still animating out.
function PagedLayout({ leaving }: { leaving: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const pageKey = pathname.startsWith('/store') ? '/store' : pathname;
  usePageScrollRestoration(ref, pageKey);
  return (
    <div ref={ref} data-testid="layout">
      {leaving ? (
        <div data-page-key="/settings">
          <div data-page-scroller="store" data-testid="leaving" />
        </div>
      ) : null}
      <div key={pageKey} data-page-key={pageKey}>
        <Outlet />
      </div>
    </div>
  );
}

function setupPaged(initialEntry: string, { leaving = false } = {}) {
  const router = createMemoryRouter(
    [
      {
        element: <PagedLayout leaving={leaving} />,
        children: [
          {
            path: '/home',
            element: (
              <div data-page-scroller="home" data-testid="home">
                home
              </div>
            ),
          },
          {
            path: '/store',
            element: (
              <div data-page-scroller="store" data-testid="store-pane">
                <Outlet />
              </div>
            ),
            children: [
              { index: true, element: <p>list</p> },
              { path: ':appId', element: <p>app</p> },
            ],
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

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

  it('returns to an offset scrolled before a same-URL replace on back', async () => {
    const { router, scroller } = setup();
    scrollTo(scroller, 900);
    // The store page re-syncs its URL, which gives the entry a new key.
    await act(() => router.navigate('/store?category=all', { replace: true }));
    await act(() => router.navigate('/store/app-1'));

    await act(() => router.navigate(-1));
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
    const { router, scroller, model } = setup();
    scrollTo(scroller, 900);
    await act(() => router.navigate('/store/app-1'));

    model.max = 300; // the list is still loading when back lands
    await act(() => router.navigate(-1));
    expect(scroller.scrollTop).toBe(300);

    model.max = 5_000; // data arrives
    await nextFrame();
    expect(scroller.scrollTop).toBe(900);
  });

  it('carries a pending restore across a same-URL replace', async () => {
    const { router, scroller, model } = setup();
    scrollTo(scroller, 900);
    await act(() => router.navigate('/store/app-1'));

    model.max = 300;
    await act(() => router.navigate(-1));
    // The store page re-syncs its URL right after mounting.
    await act(() => router.navigate('/store?category=all', { replace: true }));

    model.max = 5_000;
    await nextFrame();
    expect(scroller.scrollTop).toBe(900);
  });

  it('stops restoring once the user scrolls', async () => {
    const { router, scroller, model } = setup();
    scrollTo(scroller, 900);
    await act(() => router.navigate('/store/app-1'));

    model.max = 300;
    await act(() => router.navigate(-1));
    scroller.dispatchEvent(new Event('wheel'));
    scrollTo(scroller, 120);

    model.max = 5_000;
    await nextFrame();
    expect(scroller.scrollTop).toBe(120);
  });

  describe('page scrollers', () => {
    it('opens a pushed page at the top of a pane that stays mounted', async () => {
      const { router, view } = setupPaged('/store');
      const pane = view.getByTestId('store-pane');
      scrollTo(pane, 900);

      await act(() => router.navigate('/store/app-1'));

      expect(view.getByTestId('store-pane')).toBe(pane);
      expect(pane.scrollTop).toBe(0);
    });

    it('restores a pane on back and forward', async () => {
      const { router, view } = setupPaged('/store');
      const pane = view.getByTestId('store-pane');
      scrollTo(pane, 900);
      await act(() => router.navigate('/store/app-1'));
      scrollTo(pane, 300);

      await act(() => router.navigate(-1));
      expect(pane.scrollTop).toBe(900);

      await act(() => router.navigate(1));
      expect(pane.scrollTop).toBe(300);
    });

    it('restores the scroller of a page that mounts again on back', async () => {
      const { router, view } = setupPaged('/home');
      scrollTo(view.getByTestId('home'), 700);
      await act(() => router.navigate('/store'));

      await act(() => router.navigate(-1));

      expect(view.getByTestId('home').scrollTop).toBe(700);
    });

    it('puts a pane the entry never scrolled at the top on back', async () => {
      const { router, view } = setupPaged('/store/app-1');
      await act(() => router.navigate('/store/app-2'));
      const pane = view.getByTestId('store-pane');
      scrollTo(pane, 400);

      await act(() => router.navigate(-1));

      expect(pane.scrollTop).toBe(0);
    });

    it('leaves the scrollers of a page that is animating out alone', async () => {
      const { router, view } = setupPaged('/store', { leaving: true });
      const leaving = view.getByTestId('leaving');
      const pane = view.getByTestId('store-pane');
      scrollTo(pane, 200);
      scrollTo(leaving, 500);

      await act(() => router.navigate('/store/app-1'));
      expect(leaving.scrollTop).toBe(500);
      expect(pane.scrollTop).toBe(0);

      await act(() => router.navigate(-1));
      expect(pane.scrollTop).toBe(200);
    });
  });
});
