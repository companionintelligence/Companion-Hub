import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { PortExposeDetailsView } from './port-expose-details-view';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { entries: [] } }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getServeStatusOptions: () => ({ queryKey: ['serve-status'] }),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    userSettings: { sslPort: 443, internalIp: '192.168.1.20', domain: 'example.com', ciHubOrganizationSlug: 'acme', ciHubDeviceSlug: 'studio' },
    cloudflareAvailable: true,
    tailscaleAvailable: false,
  }),
}));

vi.mock('@/components/app-logo/app-logo', () => ({ AppLogo: () => null }));

// The access card says who can open the port under its address; here only what the page hands it.
vi.mock('@/modules/app/components/app-access-points/app-access-points', () => ({
  AppAccessPoints: ({ openWithoutSignIn }: { openWithoutSignIn?: string | null }) => (
    <div data-testid="access-points" data-open-without-sign-in={openWithoutSignIn ?? ''} />
  ),
  buildAppAccessPoints: () => [],
  buildTailscaleServedPortSet: () => new Set<number>(),
}));

vi.mock('@/modules/app/components/dialogs/uninstall-dialog/uninstall-dialog', () => ({ UninstallDialog: () => null }));
vi.mock('@/modules/app/components/port-expose-settings-dialog/port-expose-settings-dialog', () => ({ PortExposeSettingsDialog: () => null }));

const info = { urn: 'dev-server:_user', name: 'Dev Server', kind: 'port-expose', port: 3000 } as unknown as AppInfo;

const renderView = (exposureMode: 'local' | 'cloudflare' | 'tailscale') =>
  render(
    <PortExposeDetailsView
      app={{ status: 'running', port: 3000, exposureMode, config: { kind: 'port-expose', exposureMode } } as unknown as AppDetails}
      info={info}
    />,
  );

describe('PortExposeDetailsView', () => {
  it('reminds beside its mode that a port on Public web opens for anyone with no Hub sign-in', () => {
    renderView('cloudflare');

    expect(screen.getByTestId('port-expose-open-to')).toHaveTextContent('PORT_EXPOSE_OPEN_TO_ANYONE');
    expect(screen.getByTestId('port-expose-open-to')).toHaveTextContent('PORT_EXPOSE_NO_HUB_SIGN_IN');
    expect(screen.getByTestId('access-points')).toHaveAttribute('data-open-without-sign-in', 'anyone');
  });

  it('reminds that a port on the Private VPN opens for the tailnet with no Hub sign-in', () => {
    renderView('tailscale');

    expect(screen.getByTestId('port-expose-open-to')).toHaveTextContent('PORT_EXPOSE_OPEN_TO_TAILNET');
    expect(screen.getByTestId('access-points')).toHaveAttribute('data-open-without-sign-in', 'tailnet');
  });

  it('adds no reminder to a port kept on this machine', () => {
    renderView('local');

    expect(screen.queryByTestId('port-expose-open-to')).not.toBeInTheDocument();
    expect(screen.getByTestId('access-points')).toHaveAttribute('data-open-without-sign-in', '');
  });
});
