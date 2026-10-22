import type { GetAppDto } from '@/api-client';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { installRequestKey, useInstallRequestPending, withInstallRequest } from './install-request';

const URN = 'audiomass:ci-marketplace';

describe('withInstallRequest', () => {
  const storeOnly = { app: null, info: { id: 'audiomass' } } as unknown as GetAppDto;

  it('returns the record as it is while no install request is out', () => {
    expect(withInstallRequest(storeOnly, URN, false)).toBe(storeOnly);
  });

  // The Hub writes the row only after its checks, so a read in that time finds none.
  it('shows an app with no row yet as installing while its request is out', () => {
    const shown = withInstallRequest(storeOnly, URN, true);

    expect(shown?.app).toMatchObject({ id: 'audiomass', urn: URN, status: 'installing' });
    expect(shown?.info).toBe(storeOnly.info);
  });

  it('shows the app as installing when it has not been read at all yet', () => {
    expect(withInstallRequest(undefined, URN, true)?.app).toMatchObject({ urn: URN, status: 'installing' });
  });

  it('shows a failed install being retried as installing', () => {
    const failed = { app: { id: 4, status: 'install_failed', port: 8080 } } as unknown as GetAppDto;

    expect(withInstallRequest(failed, URN, true)?.app).toMatchObject({ id: 4, status: 'installing', port: 8080 });
  });

  it('leaves an app the Hub already reports alone', () => {
    const installing = { app: { id: 4, status: 'installing' } } as unknown as GetAppDto;

    expect(withInstallRequest(installing, URN, true)).toBe(installing);
  });
});

describe('useInstallRequestPending', () => {
  it('is true from the moment the request leaves until it is answered', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    let answer!: () => void;
    const { result } = renderHook(
      () => ({
        pending: useInstallRequestPending(URN),
        install: useMutation({
          mutationKey: installRequestKey(URN),
          mutationFn: () =>
            new Promise<void>((resolve) => {
              answer = resolve;
            }),
        }),
      }),
      { wrapper },
    );

    expect(result.current.pending).toBe(false);

    act(() => {
      result.current.install.mutate();
    });
    await waitFor(() => {
      expect(result.current.pending).toBe(true);
    });

    await act(async () => {
      answer();
    });
    await waitFor(() => {
      expect(result.current.pending).toBe(false);
    });
  });

  it('ignores an install request for another app', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(
      () => ({
        pending: useInstallRequestPending(URN),
        install: useMutation({ mutationKey: installRequestKey('cyberchef:ci-marketplace'), mutationFn: () => new Promise<void>(() => {}) }),
      }),
      { wrapper },
    );

    act(() => {
      result.current.install.mutate();
    });

    await waitFor(() => {
      expect(result.current.install.isPending).toBe(true);
    });
    expect(result.current.pending).toBe(false);
  });
});
