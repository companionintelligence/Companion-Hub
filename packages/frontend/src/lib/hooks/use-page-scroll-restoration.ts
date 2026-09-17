import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { type Location, useLocation, useNavigationType } from 'react-router';

// How long a back/forward restore keeps retrying while the page is still too
// short to reach its old offset (e.g. a spinner before the data lands).
const RESTORE_WINDOW_MS = 1500;
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/** Set on the layout's page wrapper to the page it renders. */
const PAGE_KEY_ATTRIBUTE = 'data-page-key';
/** Marks an element that scrolls a page's content; the value names it within the page. */
const PAGE_SCROLLER_ATTRIBUTE = 'data-page-scroller';

// The layout's own scroller, in saved offsets.
const LAYOUT_SCROLLER = '';

type PendingRestore = { frame: number; cancel: () => void };

// The layout's scroller plus the marked scrollers of the page on screen. A page
// that is still animating out has its own wrapper, so it is left alone.
function currentScrollers(layout: HTMLElement, pageKey: string) {
  const scrollers = new Map<string, HTMLElement>([[LAYOUT_SCROLLER, layout]]);

  for (const wrapper of layout.children) {
    if (wrapper.getAttribute(PAGE_KEY_ATTRIBUTE) !== pageKey) continue;

    for (const scroller of wrapper.querySelectorAll<HTMLElement>(`[${PAGE_SCROLLER_ATTRIBUTE}]`)) {
      const name = scroller.getAttribute(PAGE_SCROLLER_ATTRIBUTE);
      if (name && !scrollers.has(name)) scrollers.set(name, scroller);
    }
  }

  return scrollers;
}

// The saved offsets of one history entry, by scroller name.
function entryOffsets(offsets: Map<string, Map<string, number>>, key: string) {
  let saved = offsets.get(key);
  if (!saved) {
    saved = new Map();
    offsets.set(key, saved);
  }
  return saved;
}

function scrollerName(layout: HTMLElement, target: EventTarget | null, pageKey: string) {
  if (target === layout) return LAYOUT_SCROLLER;
  if (!(target instanceof HTMLElement)) return null;

  const name = target.getAttribute(PAGE_SCROLLER_ATTRIBUTE);
  const page = target.closest(`[${PAGE_KEY_ATTRIBUTE}]`)?.getAttribute(PAGE_KEY_ATTRIBUTE);
  return name && page === pageKey ? name : null;
}

/**
 * Scroll handling for a layout whose pages scroll inside elements instead of
 * the window. React Router's <ScrollRestoration /> only tracks window scroll,
 * and a scroller that outlives its child routes (the layout's own, or a
 * section layout's pane) keeps the previous page's offset without this.
 *
 * It manages the layout's scroller (`scrollerRef`) and every element marked
 * `data-page-scroller="<name>"` inside the page wrapper whose `data-page-key`
 * is `pageKey`:
 *
 * - PUSH / REPLACE to a different path or query: scroll them to the top.
 * - POP (back / forward): return each to where that history entry left it.
 * - REPLACE to the same path and query (pages syncing their URL): leave the
 *   scroll alone, including a restore that is still in progress.
 *
 * Offsets live in memory only, so a reload starts at the top.
 */
export const usePageScrollRestoration = (scrollerRef: RefObject<HTMLElement | null>, pageKey: string) => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const offsets = useRef(new Map<string, Map<string, number>>());
  const previous = useRef<Location | null>(null);
  const pending = useRef<PendingRestore | null>(null);
  // The entry and page on screen. Updated at commit, before any reset below, so
  // the scroll event a reset or a shorter page causes is never recorded against
  // the entry being left.
  const shown = useRef({ key: location.key, pageKey });

  // Remember the offsets of the entry currently on screen. Scroll events don't
  // bubble, but a capturing listener on the layout sees its descendants' too.
  useEffect(() => {
    const layout = scrollerRef.current;
    if (!layout) return;

    const onScroll = (event: Event) => {
      if (pending.current) return;
      const name = scrollerName(layout, event.target, shown.current.pageKey);
      if (name === null) return;
      entryOffsets(offsets.current, shown.current.key).set(name, (event.target as HTMLElement).scrollTop);
    };

    layout.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => layout.removeEventListener('scroll', onScroll, { capture: true });
  }, [scrollerRef]);

  useEffect(() => () => pending.current?.cancel(), []);

  useLayoutEffect(() => {
    const layout = scrollerRef.current;
    const from = previous.current;
    previous.current = location;
    shown.current = { key: location.key, pageKey };

    if (!layout || !from || from.key === location.key) return;

    const samePage = from.pathname === location.pathname && from.search === location.search;

    if (navigationType !== 'POP') {
      if (samePage) return;
      pending.current?.cancel();
      for (const scroller of currentScrollers(layout, pageKey).values()) scroller.scrollTop = 0;
      return;
    }

    pending.current?.cancel();
    // A copy: offsets recorded while restoring must not move the target.
    const target = new Map(offsets.current.get(location.key));

    // Put every scroller where this entry left it (the top if it never moved),
    // and report whether they all got there.
    const apply = () => {
      const scrollers = currentScrollers(layout, pageKey);
      let reached = true;

      for (const [name, scroller] of scrollers) {
        const top = target.get(name) ?? 0;
        scroller.scrollTop = top;
        if (Math.abs(scroller.scrollTop - top) > 1) reached = false;
      }
      // A scroller the page hasn't rendered yet.
      for (const [name, top] of target) {
        if (top > 0 && !scrollers.has(name)) reached = false;
      }

      return reached;
    };

    if (apply()) return;

    // The page is not tall enough yet. Keep applying the offsets as content
    // arrives, and stop as soon as the user scrolls on their own.
    const startedAt = performance.now();
    const restore: PendingRestore = {
      frame: 0,
      cancel: () => {
        cancelAnimationFrame(restore.frame);
        for (const type of USER_SCROLL_EVENTS) layout.removeEventListener(type, restore.cancel);
        if (pending.current === restore) pending.current = null;
      },
    };
    for (const type of USER_SCROLL_EVENTS) layout.addEventListener(type, restore.cancel, { passive: true });

    const step = () => {
      if (apply() || performance.now() - startedAt > RESTORE_WINDOW_MS) {
        const saved = entryOffsets(offsets.current, shown.current.key);
        for (const [name, scroller] of currentScrollers(layout, shown.current.pageKey)) saved.set(name, scroller.scrollTop);
        restore.cancel();
        return;
      }
      restore.frame = requestAnimationFrame(step);
    };
    restore.frame = requestAnimationFrame(step);
    pending.current = restore;
  }, [scrollerRef, location, navigationType, pageKey]);
};
