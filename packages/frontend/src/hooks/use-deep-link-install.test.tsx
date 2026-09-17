import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@/tests/test-utils';
import type { InstallIntent } from '@/lib/deep-link-install';

/**
 * Tests the `cihub://install` deep-link router — the path a store link takes
 * from the OS into the app-detail page with the install sheet armed.
 *
 * The invariant that matters is the stash/navigate split: the intent is
 * ALWAYS stashed, but only navigated when the user isn't mid-setup. A link
 * that arrives during onboarding must survive to the end of it rather than
 * yanking the user out of registration (or being dropped on the floor).
 *
 * buildInstallIntentPath is deliberately left unmocked so the assertions pin
 * the real emitted path, including its encoding.
 */

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => nav.navigate,
}));

const dli = vi.hoisted(() => ({
  stashPendingInstallIntent: vi.fn(),
  takePendingInstallIntentFromDesktop: vi.fn(),
}));
vi.mock('@/lib/deep-link-install', async (orig) => ({
  ...(await orig<typeof import('@/lib/deep-link-install')>()),
  stashPendingInstallIntent: (...a: unknown[]) => dli.stashPendingInstallIntent(...a),
  takePendingInstallIntentFromDesktop: () => dli.takePendingInstallIntentFromDesktop(),
}));

const ev = vi.hoisted(() => ({
  handler: null as ((e: { payload: InstallIntent }) => void) | null,
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: InstallIntent }) => void) => {
    ev.listen(name);
    ev.handler = cb;
    return ev.unlisten;
  },
}));

const { useDeepLinkInstall } = await import('./use-deep-link-install');

const win = window as unknown as Record<string, unknown>;
const setDesktop = (on: boolean) => {
  if (on) {
    win.__TAURI_INTERNALS__ = {};
  } else {
    delete win.__TAURI_INTERNALS__;
  }
};
const setPath = (pathname: string) => {
  Object.defineProperty(window, 'location', { value: { ...window.location, pathname }, writable: true, configurable: true });
};

beforeEach(() => {
  setDesktop(true);
  setPath('/home');
  ev.handler = null;
  for (const m of [nav.navigate, ev.unlisten, ev.listen, dli.stashPendingInstallIntent]) {
    m.mockClear();
  }
  dli.takePendingInstallIntentFromDesktop.mockReset().mockResolvedValue(null);
});

describe('useDeepLinkInstall — wiring', () => {
  it('is inert outside the Tauri shell', async () => {
    setDesktop(false);
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(dli.takePendingInstallIntentFromDesktop).not.toHaveBeenCalled());
    expect(ev.listen).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('subscribes to deep-link-install and drops the listener on unmount', async () => {
    const { unmount } = renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-install'));
    unmount();
    await waitFor(() => expect(ev.unlisten).toHaveBeenCalled());
  });

  it('still listens for live links when draining the cold-start intent blows up', async () => {
    // The drain and the subscribe are independently guarded on purpose: a
    // failure to read the stashed intent must not cost us every *later* link.
    dli.takePendingInstallIntentFromDesktop.mockRejectedValue(new Error('ipc gone'));

    renderHook(() => useDeepLinkInstall());

    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-install'));
    ev.handler?.({ payload: { appSlug: 'immich', storeId: 'ci-marketplace' } });
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/store/ci-marketplace/immich?install=1', { replace: false }));
  });
});

describe('useDeepLinkInstall — routing', () => {
  it('routes a link that launched the app (cold start)', async () => {
    dli.takePendingInstallIntentFromDesktop.mockResolvedValue({ appSlug: 'immich', storeId: 'ci-marketplace', deviceId: null });

    renderHook(() => useDeepLinkInstall());

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/store/ci-marketplace/immich?install=1', { replace: false }));
    expect(dli.stashPendingInstallIntent).toHaveBeenCalledWith({ appSlug: 'immich', storeId: 'ci-marketplace', deviceId: null });
  });

  it('routes a link that arrives while the app is running', async () => {
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { appSlug: 'plane', storeId: 'ci-marketplace' } });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/store/ci-marketplace/plane?install=1', { replace: false }));
  });

  it('defaults a missing store to the marketplace', async () => {
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { appSlug: 'immich', storeId: '' } });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/store/ci-marketplace/immich?install=1', { replace: false }));
  });

  it('trims a padded slug rather than routing to a whitespace app', async () => {
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { appSlug: '  immich  ', storeId: '  ci-marketplace  ' } });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/store/ci-marketplace/immich?install=1', { replace: false }));
  });

  it('empties the copy the desktop shell parked once it has opened the app', async () => {
    // The shell parks every link as well as emitting it. Left parked, the next page load took the
    // same link and opened the install dialog again.
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());
    expect(dli.takePendingInstallIntentFromDesktop).toHaveBeenCalledTimes(1);

    ev.handler?.({ payload: { appSlug: 'immich', storeId: 'ci-marketplace' } });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/store/ci-marketplace/immich?install=1', { replace: false }));
    expect(dli.takePendingInstallIntentFromDesktop).toHaveBeenCalledTimes(2);
  });

  it.each([{ appSlug: '' }, { appSlug: '   ' }, {} as InstallIntent])('ignores a link with no app slug (%j)', async (payload) => {
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: payload as InstallIntent });
    await new Promise((r) => setTimeout(r, 10));

    expect(dli.stashPendingInstallIntent).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe('useDeepLinkInstall — mid-setup links are held, not dropped', () => {
  const SETUP_ROUTES = ['/device-registration', '/onboarding', '/restore-apps', '/login', '/register'];

  it.each(SETUP_ROUTES)('stashes without navigating while on %s', async (route) => {
    setPath(route);
    dli.takePendingInstallIntentFromDesktop.mockResolvedValue({ appSlug: 'immich', storeId: 'ci-marketplace', deviceId: null });

    renderHook(() => useDeepLinkInstall());

    // Stashed => the intent survives setup and is picked up afterwards.
    await waitFor(() => expect(dli.stashPendingInstallIntent).toHaveBeenCalled());
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('leaves a link held during setup parked for the next page load', async () => {
    // The next page load, such as the one that ends Portal sign-in, takes the parked link and opens the app.
    setPath('/login');
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { appSlug: 'immich', storeId: 'ci-marketplace' } });
    await waitFor(() => expect(dli.stashPendingInstallIntent).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));

    expect(dli.takePendingInstallIntentFromDesktop).toHaveBeenCalledTimes(1);
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('matches setup routes by prefix, so nested steps are covered too', async () => {
    setPath('/onboarding/step-2');
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { appSlug: 'immich', storeId: 'ci-marketplace' } });
    await waitFor(() => expect(dli.stashPendingInstallIntent).toHaveBeenCalled());

    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('does not mistake a normal route for a setup route on a substring', async () => {
    // '/store/login-helper' contains 'login' but does not start with it.
    setPath('/store/login-helper');
    renderHook(() => useDeepLinkInstall());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { appSlug: 'immich', storeId: 'ci-marketplace' } });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
  });
});
