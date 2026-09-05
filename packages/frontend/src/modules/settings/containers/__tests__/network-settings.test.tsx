import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NetworkSettingsContainer } from '../network-settings';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => false }));
vi.mock('@/lib/hooks/use-tailscale-readiness-sync', () => ({ useTailscaleReadinessSync: () => undefined }));
vi.mock('@/lib/clear-client-hub-state', () => ({ clearClientHubState: vi.fn() }));
vi.mock('@/lib/helpers/open-external', () => ({ openExternal: vi.fn() }));
vi.mock('@/api-client/sdk.gen', () => ({
  disconnect: vi.fn(),
  resetRegistration: vi.fn(),
  startAuth: vi.fn(),
  pairPeer: vi.fn(),
  approvePeer: vi.fn(),
  rejectPeer: vi.fn(),
  removePeer: vi.fn(),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  appContextQueryKey: () => ['ctx'],
  getStatus2QueryKey: () => ['cf'],
  getStatus2Options: () => ({
    queryKey: ['cf'],
    queryFn: async () => ({ tunnelEnabled: true, tunnelId: 'fe950a10-8659', message: 'Tunnel is managed by CI-Cloud.' }),
  }),
  getStatus5QueryKey: () => ['ts'],
  getStatus5Options: () => ({
    queryKey: ['ts'],
    queryFn: async () => ({ installed: false, connected: false, ip: null, hostname: null, backendState: null }),
  }),
  listPeersQueryKey: () => ['pool-peers'],
  listPeersOptions: () => ({ queryKey: ['pool-peers'], queryFn: async () => [] }),
  listDiscoverableQueryKey: () => ['pool-discoverable'],
  listDiscoverableOptions: () => ({ queryKey: ['pool-discoverable'], queryFn: async () => [] }),
}));

const renderContainer = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NetworkSettingsContainer />
    </QueryClientProvider>,
  );
};

describe('NetworkSettingsContainer', () => {
  it('renders both cards with status badges and the tunnel id', async () => {
    renderContainer();

    await waitFor(() => expect(screen.getByTestId('private-vpn-card')).toBeTruthy());
    expect(screen.getByTestId('cloudflare-tunnel-card')).toBeTruthy();
    expect(screen.getByText('SETTINGS_NETWORK_PRIVATE_VPN_TITLE')).toBeTruthy();
    expect(screen.getByText('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')).toBeTruthy();
    expect(screen.getByText('SETTINGS_NETWORK_INACTIVE')).toBeTruthy();
    expect(screen.getByText('SETTINGS_NETWORK_ACTIVE')).toBeTruthy();
    expect(screen.getByText('fe950a10-8659')).toBeTruthy();
    expect(screen.getByText('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED_DESC')).toBeTruthy();
  });

  it('renders the Hub Pool card with empty-state copy when nothing is paired or discoverable', async () => {
    renderContainer();

    await waitFor(() => expect(screen.getByTestId('hub-pool-card')).toBeTruthy());
    expect(screen.getByText('HUB_POOL_DISCOVERABLE_EMPTY')).toBeTruthy();
    expect(screen.getByText('HUB_POOL_PENDING_EMPTY')).toBeTruthy();
    expect(screen.getByText('HUB_POOL_CONNECTED_EMPTY')).toBeTruthy();
  });

  it('confirms re-registration in a dialog instead of window.confirm', async () => {
    renderContainer();

    const trigger = await screen.findByTestId('reregister-device-btn');
    await userEvent.click(trigger);

    await waitFor(() => expect(screen.getByText('SETTINGS_NETWORK_RESET_REGISTRATION_CONFIRM')).toBeTruthy());
    expect(screen.getByTestId('reregister-confirm-btn')).toBeTruthy();
  });
});
