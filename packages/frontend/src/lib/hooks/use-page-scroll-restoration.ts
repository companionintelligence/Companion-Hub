import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { type Location, useLocation, useNavigationType } from 'react-router';

// How long a back/forward restore keeps retrying while the page is still too
// short to reach its old offset (e.g. a spinner before the data lands).
const RESTORE_WINDOW_MS = 1500;
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

type PendingRestore = { target: number; frame: number; cancel: () => void };

/**
 * Scroll handling for a layout that scrolls inside an element instead of the
 * window. React Router's <ScrollRestoration /> only tracks window scroll, and
 * the element outlives its child routes, so without this a new page opens at
 * the previous page's offset.
 *
 * - PUSH / REPLACE to a different path or query: scroll to the top.
 * - POP (back / forward): return to where that history entry was left.
 * - REPLACE to the same path and query (pages syncing their URL): leave the
 *   scroll alone, including a restore that is still in progress.
 *
 * Offsets live in memory only, so a reload starts at the top.
 */
export const usePageScrollRestoration = (scrollerRef: RefObject<HTMLElement | null>) => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const offsets = useRef(new Map<string, number>());
  const previous = useRef<Location | null>(null);
  const pending = useRef<PendingRestore | null>(null);
  // The entry on screen. Updated at commit, before any reset below, so the
  // scroll event a reset or a shorter page causes is never recorded against
  // the entry being left.
  const shownKey = useRef(location.key);

  // Remember the offset of the entry currently on screen.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const onScroll = () => {
      if (!pending.current) offsets.current.set(shownKey.current, scroller.scrollTop);
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scrollerRef]);

  useEffect(() => () => pending.current?.cancel(), []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const from = previous.current;
    previous.current = location;
    shownKey.current = location.key;

    if (!scroller || !from || from.key === location.key) return;

    const samePage = from.pathname === location.pathname && from.search === location.search;

    if (navigationType !== 'POP') {
      if (samePage) return;
      pending.current?.cancel();
      scroller.scrollTop = 0;
      return;
    }

    pending.current?.cancel();
    const target = offsets.current.get(location.key) ?? 0;
    scroller.scrollTop = target;
    if (target === 0 || Math.abs(scroller.scrollTop - target) <= 1) return;

    // The page is not tall enough yet. Keep applying the offset as content
    // arrives, and stop as soon as the user scrolls on their own.
    const startedAt = performance.now();
    const restore: PendingRestore = {
      target,
      frame: 0,
      cancel: () => {
        cancelAnimationFrame(restore.frame);
        for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, restore.cancel);
        if (pending.current === restore) pending.current = null;
      },
    };
    for (const type of USER_SCROLL_EVENTS) scroller.addEventListener(type, restore.cancel, { passive: true });

    const step = () => {
      scroller.scrollTop = target;
      if (Math.abs(scroller.scrollTop - target) <= 1 || performance.now() - startedAt > RESTORE_WINDOW_MS) {
        offsets.current.set(shownKey.current, scroller.scrollTop);
        restore.cancel();
        return;
      }
      restore.frame = requestAnimationFrame(step);
    };
    restore.frame = requestAnimationFrame(step);
    pending.current = restore;
  }, [scrollerRef, location, navigationType]);
};
