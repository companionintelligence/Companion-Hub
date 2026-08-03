import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@/tests/test-utils';

/**
 * Tests the pairing-code capture hook.
 *
 * It exists purely for timing: HubStatus mounts long before the device
 * registration screen, so a `cihub://pair` link that lands early would hit no
 * listener at all. This hook grabs the code the moment it arrives and stashes
 * it until registration is ready to read it — so "captured while nothing is
 * listening yet" is the behaviour under test, not a side note.
 */

const pair = vi.hoisted(() => ({ stashPendingPairingCode: vi.fn() }));
vi.mock('@/lib/deep-link-pair', async (orig) => ({
  ...(await orig<typeof import('@/lib/deep-link-pair')>()),
  stashPendingPairingCode: (...a: unknown[]) => pair.stashPendingPairingCode(...a),
}));

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

const { useDeepLinkPairCapture } = await import('./use-deep-link-pair-capture');

const win = window as unknown as Record<string, unknown>;
const setDesktop = (on: boolean) => {
  if (on) {
    win.__TAURI_INTERNALS__ = {};
  } else {
    delete win.__TAURI_INTERNALS__;
  }
};

beforeEach(() => {
  setDesktop(true);
  ev.handler = null;
  ev.listen.mockClear();
  ev.unlisten.mockClear();
  pair.stashPendingPairingCode.mockClear();
});

describe('useDeepLinkPairCapture', () => {
  it('is inert outside the Tauri shell', async () => {
    setDesktop(false);
    renderHook(() => useDeepLinkPairCapture());
    await new Promise((r) => setTimeout(r, 10));
    expect(ev.listen).not.toHaveBeenCalled();
  });

  it('subscribes to deep-link-pair', async () => {
    renderHook(() => useDeepLinkPairCapture());
    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-pair'));
  });

  it('stashes a code that arrives before the registration screen exists', async () => {
    renderHook(() => useDeepLinkPairCapture());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: 'abc123' });

    // Upper-cased on the way in, so registration can compare it verbatim.
    expect(pair.stashPendingPairingCode).toHaveBeenCalledWith('ABC123');
  });

  it('accepts a padded code from a hand-typed or shared link', async () => {
    renderHook(() => useDeepLinkPairCapture());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: '  abc123  ' });

    expect(pair.stashPendingPairingCode).toHaveBeenCalledWith('ABC123');
  });

  it.each(['abc12', 'abc1234', 'abc12!', '', '   '])('drops a malformed code (%j) rather than stashing junk', async (payload) => {
    // A bad stash outlives the link: registration would later read a code that
    // can never pair and fail with no obvious cause.
    renderHook(() => useDeepLinkPairCapture());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload });

    expect(pair.stashPendingPairingCode).not.toHaveBeenCalled();
  });

  it('drops the listener on unmount', async () => {
    const { unmount } = renderHook(() => useDeepLinkPairCapture());
    await waitFor(() => expect(ev.listen).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(ev.unlisten).toHaveBeenCalled());
  });
});
