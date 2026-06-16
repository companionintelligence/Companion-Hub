import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppAccessPoints, buildAppAccessPoints } from './app-access-points';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    userSettings: {
      localDomain: 'ci.lan',
      sslPort: 443,
      internalIp: '0.0.0.0',
      domain: 'companionintelligence.com',
      ciHubOrganizationSlug: 'companion',
      ciHubDeviceSlug: 'studio',
    },
    cloudflareAvailable: true,
    tailscaleAvailable: true,
    tailscaleNodeFqdn: 'hub-tailscale-1.capybara-ulmer.ts.net',
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
  },
}));

describe('buildAppAccessPoints', () => {
  const info = {
    urn: 'openwebui:community',
    no_gui: false,
    https: false,
    url_suffix: '/login',
    port: 3000,
    dynamic_config: true,
    exposable: true,
  } as any;

  it('builds public, vpn, and local access entries for an installed app', () => {
    const accessPoints = buildAppAccessPoints({
      app: {
        status: 'running',
        port: 3000,
        localSubdomain: 'openwebui',
        domain: 'openwebui-studio-companion.companionintelligence.com',
        exposed: true,
        exposedLocal: true,
      } as any,
      info,
      sslPort: 443,
      internalIp: '0.0.0.0',
      publicDomain: 'companionintelligence.com',
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.capybara-ulmer.ts.net',
      organizationSlug: 'companion',
      deviceSlug: 'studio',
    });

    expect(accessPoints).toHaveLength(3);
    expect(accessPoints[0]).toMatchObject({
      key: 'public',
      url: 'https://openwebui-studio-companion.companionintelligence.com/login',
      state: 'active',
    });
    expect(accessPoints[1]).toMatchObject({
      key: 'vpn',
      url: 'https://hub-tailscale-1.capybara-ulmer.ts.net:3000/login',
      host: 'hub-tailscale-1.capybara-ulmer.ts.net:3000',
    });
    expect(accessPoints[2]).toMatchObject({
      key: 'local',
      url: 'http://127.0.0.1:3000/login',
    });
  });

  it('keeps tailscale links on the app vpn port instead of the hub ssl port', () => {
    const accessPoints = buildAppAccessPoints({
      app: {
        status: 'running',
        port: 3000,
        localSubdomain: 'openwebui',
        exposedLocal: true,
      } as any,
      info,
      sslPort: 8443,
      internalIp: '0.0.0.0',
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.capybara-ulmer.ts.net',
    });

    expect(accessPoints[1]).toMatchObject({
      key: 'vpn',
      url: 'https://hub-tailscale-1.capybara-ulmer.ts.net:3000/login',
    });
  });

  it('does not mark local access active for tailscale-only apps without a published host port', () => {
    const accessPoints = buildAppAccessPoints({
      app: {
        status: 'running',
        port: 8311,
        localSubdomain: 'bitboard',
        exposureMode: 'tailscale',
        exposedLocal: false,
        openPort: false,
      } as any,
      info,
      sslPort: 8443,
      internalIp: '0.0.0.0',
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.capybara-ulmer.ts.net',
    });

    expect(accessPoints[1]).toMatchObject({
      key: 'vpn',
      url: 'https://hub-tailscale-1.capybara-ulmer.ts.net:8311/login',
      state: 'active',
    });
    expect(accessPoints[2]).toMatchObject({
      key: 'local',
      url: null,
      host: null,
      state: 'unavailable',
    });
  });
});

describe('AppAccessPoints', () => {
  it('renders the installed access panel', () => {
    render(
      <AppAccessPoints
        app={
          {
            status: 'running',
            port: 3000,
            localSubdomain: 'openwebui',
            domain: 'openwebui-studio-companion.companionintelligence.com',
            exposed: true,
            exposedLocal: true,
          } as any
        }
        info={
          {
            urn: 'openwebui:community',
            name: 'Open WebUI',
            no_gui: false,
            https: false,
            url_suffix: '/login',
            port: 3000,
            dynamic_config: true,
            exposable: true,
          } as any
        }
      />,
    );

    expect(screen.getByText('APP_DETAILS_ACCESS_TITLE')).toBeInTheDocument();
    expect(screen.getAllByText('APP_ACTION_OPEN')).toHaveLength(3);
    expect(screen.queryByText('COMMON_HOSTNAME')).not.toBeInTheDocument();
    expect(screen.getByText('https://hub-tailscale-1.capybara-ulmer.ts.net:3000/login')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:3000/login')).toBeInTheDocument();
  });

  it('hides the panel for missing apps', () => {
    const { container } = render(
      <AppAccessPoints
        app={{ status: 'missing' } as any}
        info={{ urn: 'openwebui:community', no_gui: false, https: false, dynamic_config: true, exposable: true } as any}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
