import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  derivePublicUrlState,
  nextProbeDelayMs,
  resolveProbeMessageKey,
  useAppUrlAvailability,
  type AppUrlProbeResult,
} from './use-app-url-availability';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/api-client/sdk.gen', async () => {
  const actual = await vi.importActual<typeof import('@/api-client/sdk.gen')>('@/api-client/sdk.gen');
  return {
    ...actual,
    checkAvailability: (...args: unknown[]) => h.get(...args),
    resolveAvailability: (...args: unknown[]) => h.post(...args),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const URN = 'test-app:community';

/** The hook only probes public-web/VPN apps that are actually running with a GUI. */
const EXPOSED = { appUrn: URN, status: 'running' as const, noGui: false, exposureMode: 'cloudflare' };

function probe(result: AppUrlProbeResult) {
  h.get.mockResolvedValue({ data: result });
}

describe('resolveProbeMessageKey', () => {
  it('maps known backend error codes to translation keys', () => {
    expect(resolveProbeMessageKey('DNS_NOT_FOUND')).toBe('APP_ACTION_ERROR_DNS_NOT_FOUND');
    expect(resolveProbeMessageKey('CF_TUNNEL_NOT_FOUND')).toBe('APP_ACTION_ERROR_CF_TUNNEL_NOT_FOUND');
  });

  it('returns null for unknown or absent codes so the caller can fall back to the raw detail', () => {
    expect(resolveProbeMessageKey('SOMETHING_NEW')).toBeNull();
    expect(resolveProbeMessageKey(null)).toBeNull();
    expect(resolveProbeMessageKey(undefined)).toBeNull();
  });
});

describe('nextProbeDelayMs', () => {
  const polling = { available: false, graceElapsed: false, pollingStopped: false };

  it('polls fast inside the grace window and backs off afterwards', () => {
    expect(nextProbeDelayMs(polling)).toBe(3_000);
    expect(nextProbeDelayMs({ ...polling, graceElapsed: true })).toBe(10_000);
  });

  it('stops once the route is serving or the budget is spent', () => {
    expect(nextProbeDelayMs({ ...polling, available: true })).toBeNull();
    expect(nextProbeDelayMs({ ...polling, pollingStopped: true })).toBeNull();
  });
});

describe('derivePublicUrlState', () => {
  const base = { enabled: true, hasVerdict: true, available: false, stage: null, pollingStopped: false } as const;

  it.each([
    ['idle when the probe does not apply', { ...base, enabled: false }, 'idle'],
    ['checking before the first verdict', { ...base, hasVerdict: false }, 'checking'],
    ['ready once the URL answers', { ...base, available: true }, 'ready'],
    ['propagating for a transient stage', { ...base, stage: 'propagating' as const }, 'propagating'],
    ['unreachable for a settled error', { ...base, stage: 'error' as const }, 'unreachable'],
    // Once we stop watching, "still propagating" is no longer honest.
    ['unreachable once probing is given up', { ...base, stage: 'propagating' as const, pollingStopped: true }, 'unreachable'],
    ['ready even after giving up, if the last probe succeeded', { ...base, available: true, pollingStopped: true }, 'ready'],
  ])('resolves %s', (_label, input, expected) => {
    expect(derivePublicUrlState(input)).toBe(expected);
  });
});

describe('useAppUrlAvailability', () => {
  beforeEach(() => {
    h.get.mockReset();
    h.post.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['the app is not running', { ...EXPOSED, status: 'stopped' as const }],
    ['the app is headless', { ...EXPOSED, noGui: true }],
    ['access is local-only', { ...EXPOSED, exposureMode: 'local' }],
  ])('stays idle and never probes when %s', (_label, input) => {
    const { result } = renderHook(() => useAppUrlAvailability(input), { wrapper: wrapper() });

    expect(result.current.state).toBe('idle');
    expect(h.get).not.toHaveBeenCalled();
  });

  it('reports a propagating route with the translated reason and the URL for "Open anyway"', async () => {
    probe({
      available: false,
      stage: 'propagating',
      errorCode: 'DNS_NOT_FOUND',
      detail: 'DNS record not found.',
      resolvable: true,
      appUrl: 'https://app.example.com',
    });

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.state).toBe('propagating'));
    expect(result.current.statusMessage).toBe('APP_ACTION_ERROR_DNS_NOT_FOUND');
    expect(result.current.appUrl).toBe('https://app.example.com');
    expect(result.current.resolvable).toBe(true);
    expect(result.current.withinGracePeriod).toBe(true);
  });

  it('falls back to the backend detail when the error code is unknown', async () => {
    probe({ available: false, stage: 'propagating', errorCode: 'BRAND_NEW_CODE', detail: 'Something specific happened.' });

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.statusMessage).toBe('Something specific happened.'));
  });

  it('reports ready once the URL answers', async () => {
    probe({ available: true, stage: 'ready', appUrl: 'https://app.example.com' });

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.statusMessage).toBeNull();
  });

  it('stays at checking when the probe request itself fails', async () => {
    // A Hub-side failure says nothing about the app; the UI must stay neutral
    // rather than accuse a perfectly healthy app of being unreachable.
    h.get.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(h.get).toHaveBeenCalled());
    expect(result.current.state).toBe('checking');
  });

  it('surfaces a settled failure verdict immediately, with the reason', async () => {
    probe({ available: false, stage: 'error', errorCode: 'NO_DEVICE_REGISTRATION', detail: 'Device not registered.', resolvable: false });

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.state).toBe('unreachable'));
    expect(result.current.statusMessage).toBe('APP_ACTION_ERROR_NO_DEVICE_REGISTRATION');
    expect(result.current.resolvable).toBe(false);
  });

  it('gives up and drops out of the grace window once the probing budget is spent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    probe({ available: false, stage: 'propagating', errorCode: 'DNS_NOT_FOUND' });

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.state).toBe('propagating'));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.withinGracePeriod).toBe(false);
    expect(result.current.state).toBe('propagating');

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(result.current.pollingStopped).toBe(true);
    expect(result.current.state).toBe('unreachable');
  });

  it('does not trust a cached verdict from before the app was restarted', async () => {
    // React Query keeps the cache entry while the probe is disabled, so without
    // a run boundary the old "available" would enable Open against a route that
    // has not come back up.
    probe({ available: true, stage: 'ready', appUrl: 'https://app.example.com' });

    const { result, rerender } = renderHook((props: { status: 'running' | 'stopped' }) => useAppUrlAvailability({ ...EXPOSED, ...props }), {
      wrapper: wrapper(),
      initialProps: { status: 'running' } as { status: 'running' | 'stopped' },
    });

    await waitFor(() => expect(result.current.state).toBe('ready'));

    rerender({ status: 'stopped' });
    expect(result.current.state).toBe('idle');

    // Restarted: the route is propagating again, but the stale cached verdict
    // is still in the cache when the probe re-enables.
    probe({ available: false, stage: 'propagating', errorCode: 'DNS_NOT_FOUND' });
    rerender({ status: 'running' });

    expect(result.current.state).not.toBe('ready');
    await waitFor(() => expect(result.current.state).toBe('propagating'));
  });

  it('re-arms the grace window when the target app changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    probe({ available: false, stage: 'propagating', errorCode: 'DNS_NOT_FOUND' });

    const { result, rerender } = renderHook((props: { appUrn: string }) => useAppUrlAvailability({ ...EXPOSED, appUrn: props.appUrn }), {
      wrapper: wrapper(),
      initialProps: { appUrn: URN },
    });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.withinGracePeriod).toBe(false);

    // Navigating to another app's detail page reuses this component; the new
    // app must not inherit the previous one's exhausted window.
    rerender({ appUrn: 'other-app:community' });
    await waitFor(() => expect(result.current.withinGracePeriod).toBe(true));
  });

  it('restarts probing from a clean slate on reset()', async () => {
    probe({ available: false, stage: 'error', errorCode: 'CONNECTION_REFUSED' });

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(h.get).toHaveBeenCalled());
    const callsBeforeReset = h.get.mock.calls.length;

    probe({ available: true, stage: 'ready', appUrl: 'https://app.example.com' });
    act(() => result.current.reset());

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(h.get.mock.calls.length).toBeGreaterThan(callsBeforeReset);
  });

  it('asks the backend to repair the route on resolve()', async () => {
    probe({ available: false, stage: 'propagating', errorCode: 'CF_TUNNEL_NOT_FOUND', resolvable: true });
    h.post.mockResolvedValue({ data: { success: true, detail: 'Re-synced DNS' } });

    const { result } = renderHook(() => useAppUrlAvailability(EXPOSED), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.state).toBe('propagating'));
    act(() => result.current.resolve());

    await waitFor(() => expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ path: { urn: URN } })));
  });
});
