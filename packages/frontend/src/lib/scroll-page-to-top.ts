import { currentScrollers } from '@/lib/hooks/use-page-scroll-restoration';

/**
 * Scroll the page on screen back to the top: the layout's scroller and every
 * `data-page-scroller` pane of the page whose wrapper has `data-page-key` set
 * to `pageKey`. It uses the same lookup as scroll restoration, so a page that
 * is still animating out is left alone.
 */
export function scrollPageToTop(layout: HTMLElement, pageKey: string) {
  const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';

  for (const scroller of currentScrollers(layout, pageKey).values()) scroller.scrollTo({ top: 0, behavior });
}
