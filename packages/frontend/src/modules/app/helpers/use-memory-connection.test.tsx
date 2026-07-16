import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemoryProviderForceGate } from './use-memory-connection';

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api-client/client.gen', () => ({ client: { get: (...args: unknown[]) => h.get(...args) } }));

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
