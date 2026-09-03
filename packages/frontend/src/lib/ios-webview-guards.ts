import { isMobileClient } from '@/lib/mobile-connection';

/**
 * WKWebView paints a blank white page when the Hub does any of:
 *   - slide a route with transform/opacity (Framer Motion page transitions)
 *   - lock document.body (Radix modal = react-remove-scroll)
 *   - pin body color/background with inline styles (theme tokens never win)
 *
 * Phone navigation tests assert these instead of screenshotting the Simulator.
 */
export function shouldSkipIosPageSlide(): boolean {
  return isMobileClient();
}

export function isBodyScrollLocked(body: HTMLElement = document.body): boolean {
  return body.style.pointerEvents === 'none' || body.getAttribute('data-scroll-locked') === '1';
}

export function isBodyThemeLocked(body: HTMLElement = document.body): boolean {
  return Boolean(body.style.color || body.style.background || body.style.backgroundColor);
}

export function pageHasVisibleChrome(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('[data-testid="app-header"], [data-testid="mobile-app-menu-btn"], main, [role="main"]'));
}
