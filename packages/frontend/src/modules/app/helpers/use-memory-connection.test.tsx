import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemoryConnection, useMemoryProviderForceGate } from './use-memory-connection';

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api-client/client.gen', () => ({ client: { get: (...args: unknown[]) => h.get(...args) } }));

const ext = vi.hoisted(() => ({ openExternalWithHubSession: vi.fn(), getTauriInvoke: vi.fn() }));
vi.mock('@/lib/hub-browser-handoff', () => ({ openExternalWithHubSession: ext.openExternalWithHubSession }));
vi.mock('@/lib/helpers/tauri-invoke', () => ({ getTauriInvoke: ext.getTauriInvoke }));

const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const PROVIDER = 'ci-memory:ci-marketplace';
const NORMAL = 'plane:ci-marketplace';

describe('useMemoryProviderForceGate', () => {
  beforeEach(() => h.get.mockReset());

  it('never fetches or requires force for a non-provider app', () => {
    const { result } = renderHook(() => useMemoryProviderForceGate(NORMAL, true), { wrapper: wrapper() });

    expect(result.current.requiresForce).toBe(false);
    expect(result.current.submitDisabled).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('requires force when the provider has connected consumers', async () => {
    h.get.mockResolvedValue({ data: { consumers: [{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }] } });
    const { result } = renderHook(() => useMemoryProviderForceGate(PROVIDER, true), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.requiresForce).toBe(true));
    expect(result.current.consumers).toHaveLength(1);
    expect(result.current.unableToVerify).toBe(false);
    expect(result.current.submitDisabled).toBe(true);
  });

  it('does not require force when the provider has zero consumers', async () => {
    h.get.mockResolvedValue({ data: { consumers: [] } });
    const { result } = renderHook(() => useMemoryProviderForceGate(PROVIDER, true), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.submitDisabled).toBe(false));
    expect(result.current.requiresForce).toBe(false);
    expect(result.current.unableToVerify).toBe(false);
  });

  // Note: the fail-closed path (fetch errors → unableToVerify → requiresForce) is
  // covered end-to-end by the uninstall dialog's "generic warning" test, which
  // exercises the unableToVerify render + gating without fighting react-query's
  // errored-query unhandled-rejection handling under vitest.

  it('stays inert while the dialog is closed', () => {
    const { result } = renderHook(() => useMemoryProviderForceGate(PROVIDER, false), { wrapper: wrapper() });

    expect(result.current.requiresForce).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe('useMemoryConnection connect()', () => {
  const CONNECT_URL = 'https://hub.example.com/api/memory-connect/start?app=plane%3Aci-marketplace';
  const CURRENT_HREF = 'https://myhub.example.com/apps/plane%3Aci-marketplace';

  const READY_STATUS = {
    applicable: true,
    memoryInstalled: true,
    memoryReady: true,
    providerStatus: 'ready',
    state: 'unconfigured',
    connectUrl: CONNECT_URL,
    connectUrlLocal: null,
    connectable: true,
    reason: null,
    keyExpiresAt: null,
  };

  // connect() reads and (on web) writes window.location.href. jsdom's real
  // Location can't be assigned, so swap in a plain stand-in that captures the
  // navigation and restore it afterwards.
  const originalLocation = window.location;

  beforeEach(() => {
    h.get.mockReset();
    ext.openExternalWithHubSession.mockReset();
    ext.getTauriInvoke.mockReset();
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: CURRENT_HREF } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  const renderReady = async () => {
    h.get.mockResolvedValue({ data: READY_STATUS });
    const { result } = renderHook(() => useMemoryConnection(NORMAL), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.connectUrl).toBe(CONNECT_URL));
    return result;
  };

  it('desktop: hands the flow to the system browser and never navigates the webview', async () => {
    ext.getTauriInvoke.mockReturnValue(vi.fn()); // inside the Tauri desktop app
    const result = await renderReady();

    result.current.connect();

    // The session-handoff helper is responsible for planting the Hub cookie in the
    // system browser before opening; use-memory-connection just delegates to it.
    expect(ext.openExternalWithHubSession).toHaveBeenCalledWith(CONNECT_URL);
    expect(window.location.href).toBe(CURRENT_HREF); // webview stayed put
  });

  it('desktop: refetches this app status the first time the window regains focus after connect', async () => {
    ext.getTauriInvoke.mockReturnValue(vi.fn());
    const result = await renderReady();
    expect(h.get).toHaveBeenCalledTimes(1); // initial status load

    result.current.connect(); // arms the one-shot focus listener

    // The consent completes in a separate browser; returning to the desktop app
    // fires window 'focus', which must invalidate + refetch this app's status.
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));

    // One-shot: a second focus must NOT trigger another refetch.
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('web: does not arm a focus listener (full-page return refreshes instead)', async () => {
    ext.getTauriInvoke.mockReturnValue(null);
    const result = await renderReady();
    expect(h.get).toHaveBeenCalledTimes(1);

    result.current.connect();

    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(h.get).toHaveBeenCalledTimes(1); // no extra refetch on focus in the browser
  });

  it('web: navigates same-origin with a next param back to this page', async () => {
    ext.getTauriInvoke.mockReturnValue(null); // plain browser (web client)
    const result = await renderReady();

    result.current.connect();

    expect(ext.openExternalWithHubSession).not.toHaveBeenCalled();
    expect(window.location.href).toBe(`/api/memory-connect/start?app=${encodeURIComponent(NORMAL)}&next=${encodeURIComponent(CURRENT_HREF)}`);
  });

  it('does nothing when there is no connect URL', async () => {
    ext.getTauriInvoke.mockReturnValue(vi.fn());
    h.get.mockResolvedValue({
      data: { ...READY_STATUS, connectUrl: null, connectable: false, reason: 'memory_starting', memoryReady: false, providerStatus: 'starting' },
    });
    const { result } = renderHook(() => useMemoryConnection(NORMAL), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.applicable).toBe(true));

    result.current.connect();

    expect(ext.openExternalWithHubSession).not.toHaveBeenCalled();
    expect(window.location.href).toBe(CURRENT_HREF);
  });
});
