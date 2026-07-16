import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@/tests/test-utils';
import type { IntentAction, IntentNavigation } from '@/lib/app-intents';

/**
 * Tests the always-on App Intent router (mounted in HubStatus).
 *
 * This is the hook every Siri / Shortcuts / Spotlight / Action Button
 * invocation lands in — both the cold-start path (the Rust shell stashed the
 * intent before the UI mounted) and the live path (`deep-link-intent` event
 * while running). The `resolveIntentNavigation` decision itself is unit-tested
 * in lib/app-intents.test.ts; here we cover the *wiring*: draining, listening,
 * navigate-vs-hard-reload, mobile gating, and listener cleanup.
 */

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => nav.navigate,
}));

const mc = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/lib/mobile-connection', () => ({ isTauriMobileSync: () => mc.mobile }));

const ai = vi.hoisted(() => ({
  takePendingIntent: vi.fn(async (): Promise<IntentAction | null> => null),
  loadKnownHubs: vi.fn(async () => [] as Array<{ id: string; name: string; hubUrl: string | null }>),
  resolveIntentNavigation: vi.fn(async (..._a: unknown[]): Promise<IntentNavigation> => ({ path: '/', reload: false })),
  parseIntentAction: vi.fn((raw: string | null | undefined): IntentAction | null => (raw === 'settings' ? { kind: 'settings' } : null)),
}));
vi.mock('@/lib/app-intents', () => ({
  takePendingIntent: () => ai.takePendingIntent(),
  loadKnownHubs: () => ai.loadKnownHubs(),
  resolveIntentNavigation: (...a: unknown[]) => ai.resolveIntentNavigation(...a),
  parseIntentAction: (raw: string | null | undefined) => ai.parseIntentAction(raw),
}));

// Capture the `deep-link-intent` listener so tests can fire events at it.
const ev = vi.hoisted(() => ({
  handler: null as ((e: { payload: string }) => void) | null,
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: string }) => void) => {
    ev.listen(name);
    ev.handler = cb;
    return ev.unlisten;
  },
}));

const { useAppIntentDeepLinks } = await import('./use-app-intent-deep-links');

// window.location.assign throws "Not implemented" in jsdom — stub it so the
// hard-reload path is assertable.
const assign = vi.fn();
beforeEach(() => {
  mc.mobile = true;
  nav.navigate.mockClear();
  assign.mockClear();
  ev.handler = null;
  ev.unlisten.mockClear();
  ev.listen.mockClear();
  ai.takePendingIntent.mockReset().mockResolvedValue(null);
  ai.loadKnownHubs.mockReset().mockResolvedValue([]);
  ai.resolveIntentNavigation.mockReset().mockResolvedValue({ path: '/', reload: false });
  ai.parseIntentAction.mockReset().mockImplementation((raw) => (raw === 'settings' ? { kind: 'settings' } : null));
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true, configurable: true });
});

describe('useAppIntentDeepLinks', () => {
  it('is inert off mobile — no intent drain, no listener', async () => {
    mc.mobile = false;
    renderHook(() => useAppIntentDeepLinks());
    await waitFor(() => expect(ai.takePendingIntent).not.toHaveBeenCalled());
    expect(ev.listen).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('subscribes to deep-link-intent on mobile', async () => {
    renderHook(() => useAppIntentDeepLinks());
    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-intent'));
  });

  it('routes a cold-start intent stashed by the Rust shell before the UI mounted', async () => {
    // Siri launched the app: the intent was captured pre-mount and stashed.
    ai.takePendingIntent.mockResolvedValue({ kind: 'settings' });
    ai.resolveIntentNavigation.mockResolvedValue({ path: '/settings', reload: false });

    renderHook(() => useAppIntentDeepLinks());

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/settings'));
    expect(ai.resolveIntentNavigation).toHaveBeenCalledWith({ kind: 'settings' }, []);
    expect(assign).not.toHaveBeenCalled(); // SPA navigation, not a reload
  });

  it('routes a live intent fired while the app is running', async () => {
    renderHook(() => useAppIntentDeepLinks());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ai.resolveIntentNavigation.mockResolvedValue({ path: '/settings', reload: false });
    ev.handler?.({ payload: 'settings' });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/settings'));
  });

  it('hard-reloads (not SPA-navigates) when the Hub connection changed', async () => {
    // Re-pointing at a different Hub must re-init the API client, so the
    // resolver asks for a full document load.
    ai.takePendingIntent.mockResolvedValue({ kind: 'open', hub: 'Apple Hub' });
    ai.resolveIntentNavigation.mockResolvedValue({ path: '/', reload: true });

    renderHook(() => useAppIntentDeepLinks());

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('ignores an unrecognised intent payload', async () => {
    renderHook(() => useAppIntentDeepLinks());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: 'bogus' }); // parseIntentAction -> null

    await waitFor(() => expect(ai.parseIntentAction).toHaveBeenCalledWith('bogus'));
    expect(ai.resolveIntentNavigation).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when nothing was pending', async () => {
    renderHook(() => useAppIntentDeepLinks());
    await waitFor(() => expect(ai.takePendingIntent).toHaveBeenCalled());
    expect(ai.resolveIntentNavigation).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('drops the listener on unmount (no leak across remounts)', async () => {
    const { unmount } = renderHook(() => useAppIntentDeepLinks());
    await waitFor(() => expect(ev.listen).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(ev.unlisten).toHaveBeenCalled());
  });

  it('does not navigate after unmount (late resolve is discarded)', async () => {
    // A slow resolve that lands after teardown must not yank the next screen.
    let release: (v: IntentNavigation) => void = () => {};
    ai.takePendingIntent.mockResolvedValue({ kind: 'settings' });
    ai.resolveIntentNavigation.mockReturnValue(
      new Promise<IntentNavigation>((res) => {
        release = res;
      }),
    );

    const { unmount } = renderHook(() => useAppIntentDeepLinks());
    await waitFor(() => expect(ai.resolveIntentNavigation).toHaveBeenCalled());
    unmount();
    release({ path: '/settings', reload: false });

    await new Promise((r) => setTimeout(r, 10));
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
