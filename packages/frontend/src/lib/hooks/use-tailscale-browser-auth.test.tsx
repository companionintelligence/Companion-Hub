import { startAuth } from '@/api-client/sdk.gen';
import { openExternal } from '@/lib/helpers/open-external';
import { sdkFail, sdkOk } from '@/tests/sdk-mock-helpers';
import en from '@ci-hub/common/i18n/translations/en.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTailscaleBrowserAuth } from './use-tailscale-browser-auth';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/helpers/open-external', () => ({ openExternal: vi.fn() }));
vi.mock('@/api-client/sdk.gen', () => ({ startAuth: vi.fn() }));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  appContextQueryKey: () => ['app-context'],
  // The Tailscale status route is reached through `named-status-routes`, which aliases getStatus3.
  getStatus3QueryKey: () => ['tailscale-status'],
}));

const startAuthMock = vi.mocked(startAuth);
const openExternalMock = vi.mocked(openExternal);

const setup = (options?: Parameters<typeof useTailscaleBrowserAuth>[0]) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidated: unknown[] = [];
  vi.spyOn(client, 'invalidateQueries').mockImplementation(async (filters) => {
    invalidated.push(filters?.queryKey);
  });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useTailscaleBrowserAuth(options), { wrapper });
  const run = async () => {
    await act(async () => {
      hook.result.current.mutate();
    });
  };
  return { ...hook, invalidated, run };
};

describe('useTailscaleBrowserAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openExternalMock.mockResolvedValue(true);
  });

  it('opens the auth URL, says so, and re-reads Tailscale and app context', async () => {
    startAuthMock.mockResolvedValue(sdkOk({ success: true, authUrl: 'https://login.example.com/a/abc123' }) as never);
    const { run, invalidated } = setup();

    await run();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.SETTINGS_NETWORK_TAILSCALE_AUTH_OPENING));
    expect(openExternalMock).toHaveBeenCalledWith('https://login.example.com/a/abc123');
    expect(invalidated).toEqual(expect.arrayContaining([['tailscale-status'], ['app-context']]));
  });

  it('tells the caller the browser opened only when the opener succeeded', async () => {
    startAuthMock.mockResolvedValue(sdkOk({ success: true, authUrl: 'https://login.example.com/a/abc123' }) as never);
    const onBrowserOpened = vi.fn();
    const opened = setup({ onBrowserOpened });
    await opened.run();
    await waitFor(() => expect(onBrowserOpened).toHaveBeenCalledTimes(1));

    onBrowserOpened.mockClear();
    openExternalMock.mockResolvedValue(false);
    const refused = setup({ onBrowserOpened });
    await refused.run();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED));
    expect(onBrowserOpened).not.toHaveBeenCalled();
  });

  it('reports a Hub that is already connected without opening a browser, and still refreshes', async () => {
    startAuthMock.mockResolvedValue(sdkOk({ success: true, alreadyAuthenticated: true }) as never);
    const { run, invalidated } = setup();

    await run();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.SETTINGS_NETWORK_TAILSCALE_ALREADY_CONNECTED));
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(invalidated).toEqual(expect.arrayContaining([['tailscale-status'], ['app-context']]));
  });

  it('shows the backend error when the Hub refuses to start sign-in, and the not-installed text when it gives none', async () => {
    startAuthMock.mockResolvedValueOnce(sdkOk({ success: false, error: 'tailscaled is not running' }) as never);
    const first = setup();
    await first.run();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('tailscaled is not running'));

    startAuthMock.mockResolvedValueOnce(sdkOk({ success: false }) as never);
    const second = setup();
    await second.run();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED));
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('says the browser could not be opened when the opener returns false, and still refreshes', async () => {
    startAuthMock.mockResolvedValue(sdkOk({ success: true, authUrl: 'https://login.example.com/a/abc123' }) as never);
    openExternalMock.mockResolvedValue(false);
    const { run, invalidated } = setup();

    await run();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED));
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidated).toContainEqual(['tailscale-status']);
  });

  it('says the browser sign-in failed when the request itself fails or throws', async () => {
    startAuthMock.mockResolvedValueOnce(sdkFail(500) as never);
    const failed = setup();
    await failed.run();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED));

    vi.mocked(toast.error).mockClear();
    startAuthMock.mockRejectedValueOnce(new Error('network down'));
    const thrown = setup();
    await thrown.run();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED));
  });
});
