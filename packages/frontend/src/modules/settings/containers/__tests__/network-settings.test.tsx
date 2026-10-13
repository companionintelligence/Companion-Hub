import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { startAuth } from '@/api-client/sdk.gen';
import { openExternal } from '@/lib/helpers/open-external';
import { NetworkSettingsContainer } from '../network-settings';

const fixtures = vi.hoisted(() => ({
  poolStatus: {} as Record<string, unknown>,
  tailscaleStatus: { installed: false, connected: false, ip: null, hostname: null, backendState: null } as Record<string, unknown>,
  tailscaleFails: false,
  cloudflareFails: false,
  hardware: { gpu: { containerHostKind: 'docker-desktop' } } as Record<string, unknown>,
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => false }));
vi.mock('@/lib/hooks/use-tailscale-readiness-sync', () => ({ useTailscaleReadinessSync: () => undefined }));
vi.mock('@/lib/clear-client-hub-state', () => ({ clearClientHubState: vi.fn() }));
vi.mock('@/lib/helpers/open-external', () => ({ openExternal: vi.fn() }));
vi.mock('@/api-client/sdk.gen', () => ({
  disconnect: vi.fn(),
  resetRegistration: vi.fn(),
  checkForRemoval: vi.fn(),
  startAuth: vi.fn(),
  pairPeer: vi.fn(),
  approvePeer: vi.fn(),
  rejectPeer: vi.fn(),
  removePeer: vi.fn(),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  appContextQueryKey: () => ['ctx'],
  getPortalConfigOptions: () => ({
    queryKey: ['portal-config'],
    queryFn: async () => ({ portalUrl: 'https://portal.example.com', deviceId: 'hw-123', registrationUrl: null, demoMode: false }),
  }),
  getStatus2QueryKey: () => ['cf'],
  getStatus2Options: () => ({
    queryKey: ['cf'],
    queryFn: async () => {
      if (fixtures.cloudflareFails) throw new Error('tunnel status failed');
      return { tunnelEnabled: true, tunnelId: 'fe950a10-8659', message: 'Tunnel is managed by CI-Cloud.' };
    },
  }),
  getStatus3QueryKey: () => ['ts'],
  getStatus3Options: () => ({
    queryKey: ['ts'],
    queryFn: async () => {
      if (fixtures.tailscaleFails) throw new Error('vpn status failed');
      return fixtures.tailscaleStatus;
    },
  }),
  poolStatusQueryKey: () => ['pool-status'],
  poolStatusOptions: () => ({ queryKey: ['pool-status'], queryFn: async () => fixtures.poolStatus }),
  listDiscoverableQueryKey: () => ['pool-discoverable'],
  listDiscoverableOptions: () => ({ queryKey: ['pool-discoverable'], queryFn: async () => [] }),
  getPoolRoutingLogQueryKey: () => ['pool-routing-log'],
  getPoolRoutingLogOptions: () => ({
    queryKey: ['pool-routing-log'],
    queryFn: async () => ({ entries: [], summary: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null } }),
  }),
  updatePoolSettingsMutation: () => ({ mutationFn: vi.fn() }),
  getHardwareOptions: () => ({ queryKey: ['hardware'], queryFn: async () => fixtures.hardware }),
}));

const renderContainer = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NetworkSettingsContainer />
    </QueryClientProvider>,
  );
};

const poolStatus = () => ({
  enabled: true,
  disabledBy: null,
  reason: 'no_peers',
  routingActive: false,
  directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
  settings: { poolEnabled: true, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
  tailscaleAdminApiConfigured: true,
  localNode: {
    nodeFqdn: 'hub-a.example-tailnet.ts.net',
    tailnet: 'example-tailnet.ts.net',
    tailscaleConnected: true,
    inFlightRequests: 0,
    hardwareTier: 'workstation',
    backends: [],
    capabilitiesError: null,
  },
  peers: [],
  peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0, disabled: 0 },
  routing: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null },
});

describe('NetworkSettingsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.poolStatus = poolStatus();
    fixtures.tailscaleStatus = { installed: false, connected: false, ip: null, hostname: null, backendState: null };
    fixtures.tailscaleFails = false;
    fixtures.cloudflareFails = false;
    fixtures.hardware = { gpu: { containerHostKind: 'docker-desktop' } };
  });

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

  it('shows an error and a retry when the VPN status cannot be loaded, not Inactive', async () => {
    fixtures.tailscaleFails = true;
    renderContainer();

    const card = await screen.findByTestId('private-vpn-card');
    expect(within(card).getByTestId('tailscale-status-error').textContent).toBe('SETTINGS_NETWORK_STATUS_ERROR');
    expect(within(card).getByRole('button', { name: 'COMMON_RETRY' })).toBeTruthy();
    expect(within(card).queryByText('SETTINGS_NETWORK_INACTIVE')).toBeNull();

    fixtures.tailscaleFails = false;
    fixtures.tailscaleStatus = { installed: true, connected: false, ip: null, hostname: null, backendState: null };
    fireEvent.click(within(card).getByRole('button', { name: 'COMMON_RETRY' }));

    await waitFor(() => expect(within(screen.getByTestId('private-vpn-card')).getByText('SETTINGS_NETWORK_INACTIVE')).toBeTruthy());
    expect(within(screen.getByTestId('private-vpn-card')).queryByTestId('tailscale-status-error')).toBeNull();
  });

  it('shows an error and a retry when the tunnel status cannot be loaded, not Inactive', async () => {
    fixtures.cloudflareFails = true;
    renderContainer();

    const card = await screen.findByTestId('cloudflare-tunnel-card');
    expect(within(card).getByTestId('cloudflare-status-error').textContent).toBe('SETTINGS_NETWORK_STATUS_ERROR');
    expect(within(card).queryByText('SETTINGS_NETWORK_INACTIVE')).toBeNull();
    expect(within(card).queryByText('SETTINGS_NETWORK_ACTIVE')).toBeNull();
  });

  it('still renders the Hub Pool section inside the Network tab', async () => {
    renderContainer();

    await waitFor(() => expect(screen.getByTestId('hub-pool-card')).toBeTruthy());
    expect(screen.getByText('HUB_POOL_CONNECTED_EMPTY')).toBeTruthy();
  });

  it('confirms re-registration in a dialog instead of window.confirm', async () => {
    renderContainer();

    const trigger = await screen.findByTestId('reregister-device-btn');
    await userEvent.click(trigger);

    await waitFor(() => expect(screen.getByText('SETTINGS_HUB_ACCOUNT_RESET_CONFIRM')).toBeTruthy());
    expect(screen.getByTestId('reregister-confirm-btn')).toBeTruthy();
  });

  it('keeps the account actions out of the tunnel card', async () => {
    renderContainer();

    const tunnelCard = await screen.findByTestId('cloudflare-tunnel-card');
    const accountCard = screen.getByTestId('hub-account-card');

    expect(tunnelCard.querySelector('[data-testid="reregister-device-btn"]')).toBeNull();
    expect(accountCard.querySelector('[data-testid="reregister-device-btn"]')).toBeTruthy();
    expect(accountCard.querySelector('[data-testid="remove-hub-from-account-btn"]')).toBeTruthy();
  });

  it('shows the opening toast only when the system opener actually reports success', async () => {
    fixtures.tailscaleStatus = { installed: true, connected: false, ip: null, hostname: null, backendState: null };
    vi.mocked(startAuth).mockResolvedValue({ data: { success: true, authUrl: 'https://login.tailscale.com/a/abc123' }, error: undefined });
    vi.mocked(openExternal).mockResolvedValue(true);

    renderContainer();

    const connectBtn = await screen.findByTestId('tailscale-connect-btn');
    await userEvent.click(connectBtn);

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://login.tailscale.com/a/abc123'));
    expect(toast.success).toHaveBeenCalledWith('SETTINGS_NETWORK_TAILSCALE_AUTH_OPENING');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows an error, not a false success toast, when the system opener silently fails', async () => {
    // Regression test: openExternal never throws on a failed open (an ACL denial,
    // a scope rejection, a stale opener-plugin chunk) -- it logs and resolves
    // false. Before this was awaited, the button showed "Opening..." regardless.
    fixtures.tailscaleStatus = { installed: true, connected: false, ip: null, hostname: null, backendState: null };
    vi.mocked(startAuth).mockResolvedValue({ data: { success: true, authUrl: 'https://login.tailscale.com/a/abc123' }, error: undefined });
    vi.mocked(openExternal).mockResolvedValue(false);

    renderContainer();

    const connectBtn = await screen.findByTestId('tailscale-connect-btn');
    await userEvent.click(connectBtn);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  describe('when tailscaled refuses the Hub its Tailscale Serve changes (CI-Hub#1766)', () => {
    const remedy = 'u="$(id -nu 1000)" && sudo tailscale set --operator="$u"';
    const connected = { installed: true, connected: true, ip: '100.64.0.17', hostname: 'laptop', backendState: 'Running', httpsAvailable: true };

    it('says why, since when, and copies the command that ends it', async () => {
      // Until now only the Hub's log said this; the page showed nothing and every Private VPN app read "Pending".
      fixtures.tailscaleStatus = { ...connected, servePermission: { denied: true, remedy, deniedSince: '2026-10-01T09:00:00.000Z' } };
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });

      renderContainer();

      const refusal = await screen.findByTestId('tailscale-serve-refused');
      expect(within(screen.getByTestId('private-vpn-card')).getByTestId('tailscale-serve-refused')).toBe(refusal);
      expect(refusal).toHaveTextContent('SETTINGS_NETWORK_TAILSCALE_SERVE_REFUSED_DESC');
      expect(refusal).toHaveTextContent('SETTINGS_NETWORK_TAILSCALE_SERVE_REFUSED_SINCE');
      expect(screen.getByTestId('tailscale-serve-remedy').textContent).toBe(remedy);

      fireEvent.click(screen.getByTestId('tailscale-serve-remedy-copy'));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(remedy));
      await waitFor(() => expect(within(refusal).getByRole('status')).toHaveTextContent('SETTINGS_NETWORK_TAILSCALE_SERVE_COMMAND_COPIED'));
    });

    it('says nothing about it while tailscaled accepts them', async () => {
      fixtures.tailscaleStatus = { ...connected, servePermission: { denied: false, remedy: null, deniedSince: null } };

      renderContainer();

      await screen.findByTestId('private-vpn-card');
      expect(screen.queryByTestId('tailscale-serve-refused')).toBeNull();
    });
  });

  describe('when the Hub runs on the Docker engine inside WSL (CI-Hub#1933)', () => {
    it('says other devices on the network cannot open the Hub', async () => {
      // WSL forwards the Hub's ports to this PC's loopback address only, and nothing said so.
      fixtures.hardware = { gpu: { containerHostKind: 'wsl-engine' } };

      renderContainer();

      const card = await screen.findByTestId('local-network-card');
      expect(card).toHaveTextContent('SETTINGS_NETWORK_LOCAL_TITLE');
      expect(card).toHaveTextContent('SETTINGS_NETWORK_LOCAL_THIS_PC_ONLY');
      expect(card).toHaveTextContent('SETTINGS_NETWORK_LOCAL_WSL_ENGINE_DESC');
    });

    it('says nothing about it on another engine', async () => {
      renderContainer();

      await screen.findByTestId('cloudflare-tunnel-card');
      await waitFor(() => expect(screen.queryByTestId('local-network-card')).toBeNull());
    });
  });
});
