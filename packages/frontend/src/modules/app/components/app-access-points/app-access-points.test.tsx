import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppAccessPoints, buildAppAccessPoints, isLoopbackAccessUrl, isMalformedAccessUrl, resolveReachableHubHost } from './app-access-points';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { entries: [{ listenPort: 3000 }, { listenPort: 8311 }] },
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getServeStatusOptions: () => ({ queryKey: ['serve-status'], queryFn: vi.fn() }),
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
    tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
    tailscaleHttpsEnabled: true,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
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
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
      tailscaleHttpsEnabled: true,
      tailscaleServedPorts: new Set([3000]),
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
      url: 'https://hub-tailscale-1.example.ts.net:3000/login',
      host: 'hub-tailscale-1.example.ts.net:3000',
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
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
    });

    expect(accessPoints[1]).toMatchObject({
      key: 'vpn',
      url: 'https://hub-tailscale-1.example.ts.net:3000/login',
    });
  });

  it('marks local access active for cloudflare-exposed apps that still publish a host port', () => {
    const accessPoints = buildAppAccessPoints({
      app: {
        status: 'running',
        port: 18789,
        localSubdomain: 'openclaw',
        exposureMode: 'cloudflare',
        exposedLocal: true,
        openPort: false,
        domain: 'openclaw-studio-companion.companionintelligence.com',
        exposed: true,
      } as any,
      info: { ...info, urn: 'openclaw:ci-marketplace' },
      sslPort: 443,
      internalIp: '0.0.0.0',
      publicDomain: 'companionintelligence.com',
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
      tailscaleHttpsEnabled: true,
      tailscaleServedPorts: new Set([18789]),
      organizationSlug: 'companion',
      deviceSlug: 'studio',
    });

    expect(accessPoints[0]).toMatchObject({
      key: 'public',
      state: 'active',
    });
    expect(accessPoints[1]).toMatchObject({
      key: 'vpn',
      state: 'available',
    });
    expect(accessPoints[2]).toMatchObject({
      key: 'local',
      url: 'http://127.0.0.1:18789/login',
      state: 'active',
    });
  });

  it('uses https for direct local access when the app declares an HTTPS endpoint', () => {
    const accessPoints = buildAppAccessPoints({
      app: {
        status: 'running',
        port: 6901,
        localSubdomain: 'claude-code',
        exposureMode: 'local',
        exposedLocal: true,
      } as any,
      info: { ...info, https: true, port: 6901, url_suffix: '' },
      sslPort: 443,
      internalIp: '0.0.0.0',
      publicDomain: 'companionintelligence.com',
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    });

    expect(accessPoints[2]).toMatchObject({
      key: 'local',
      url: 'https://127.0.0.1:6901',
      state: 'active',
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
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
      tailscaleHttpsEnabled: true,
      tailscaleServedPorts: new Set([8311]),
    });

    expect(accessPoints[1]).toMatchObject({
      key: 'vpn',
      url: 'https://hub-tailscale-1.example.ts.net:8311/login',
      state: 'active',
    });
    expect(accessPoints[2]).toMatchObject({
      key: 'local',
      url: null,
      host: null,
      state: 'unavailable',
    });
  });

  it('marks public web active for cloudflare apps with a derived public URL', () => {
    const accessPoints = buildAppAccessPoints({
      app: {
        status: 'running',
        port: 3000,
        localSubdomain: 'anything-llm',
        exposureMode: 'cloudflare',
        exposed: false,
        exposedLocal: false,
      } as any,
      info,
      sslPort: 443,
      internalIp: '0.0.0.0',
      publicDomain: 'companionintelligence.com',
      cloudflareAvailable: true,
      tailscaleAvailable: false,
      organizationSlug: 'macbook-devben',
      deviceSlug: 'macbook-devben',
      hubSubdomain: 'hub-macbook-devben-macbook-devben',
    });

    expect(accessPoints[0]).toMatchObject({
      key: 'public',
      url: 'https://anything-llm-macbook-devben.companionintelligence.com/login',
      state: 'active',
      stateLabel: 'APP_DETAILS_ACCESS_ENABLED',
    });
  });

  it('marks public web active for legacy exposedLocal installs without exposureMode', () => {
    const accessPoints = buildAppAccessPoints({
      app: {
        status: 'running',
        port: 3000,
        localSubdomain: 'openwebui',
        exposedLocal: true,
        exposed: false,
      } as any,
      info,
      sslPort: 443,
      internalIp: '0.0.0.0',
      publicDomain: 'companionintelligence.com',
      cloudflareAvailable: true,
      tailscaleAvailable: false,
      organizationSlug: 'companion',
      deviceSlug: 'studio',
      hubSubdomain: 'hub-studio-companion',
    });

    expect(accessPoints[0]).toMatchObject({
      key: 'public',
      state: 'active',
    });
  });

  describe('judged by the stored install form', () => {
    /*
     * An install that sent no exposure settings (MCP `hub_install_app` with `{}`) gets a row with
     * `exposureMode: 'local'` and `exposedLocal: true`, while its stored form resolves to local.
     * Compose builds no route for it and Portal sync no longer publishes it.
     */
    const publicEntry = (app: Record<string, unknown>) =>
      buildAppAccessPoints({
        app: { status: 'running', port: 3000, exposed: false, ...app } as any,
        info,
        sslPort: 443,
        internalIp: '0.0.0.0',
        publicDomain: 'companionintelligence.com',
        cloudflareAvailable: true,
        tailscaleAvailable: false,
        organizationSlug: 'companion',
        deviceSlug: 'studio',
        hubSubdomain: 'hub-studio-companion',
      })[0];

    it('does not call Public web enabled for an install that sent no exposure settings', () => {
      expect(publicEntry({ exposureMode: 'local', exposedLocal: true, config: { openPort: true } })).toMatchObject({
        key: 'public',
        state: 'available',
        stateLabel: 'APP_DETAILS_ACCESS_NOT_CONFIGURED',
      });
    });

    it('still calls it enabled when the form carried the legacy Public web flag', () => {
      expect(publicEntry({ exposureMode: 'local', exposedLocal: true, config: { exposedLocal: true } })).toMatchObject({
        key: 'public',
        state: 'active',
      });
    });
  });

  describe('after an install that named no subdomain', () => {
    // core-2 on 2026-09-23: org demopool1, device core-2, domain ci.computer.
    const hermes = {
      urn: 'ci-hermes:ci-marketplace',
      no_gui: false,
      https: false,
      port: 18790,
      dynamic_config: true,
      exposable: true,
    } as any;
    const core2 = {
      sslPort: 443,
      publicDomain: 'ci.computer',
      cloudflareAvailable: true,
      tailscaleAvailable: false,
      organizationSlug: 'demopool1',
      deviceSlug: 'core-2',
      hubSubdomain: 'hub-core-2-demopool1',
    };

    it('links the hostname Portal serves, which carries the store slug', () => {
      // The card showed `ci-hermes-core-2-demopool1`, which is NXDOMAIN; Portal and the
      // backend build `<app>-<store>` when no subdomain was chosen.
      const accessPoints = buildAppAccessPoints({
        ...core2,
        app: { status: 'running', port: 18790, localSubdomain: null, exposureMode: 'cloudflare', exposedLocal: true } as any,
        info: hermes,
        internalIp: '0.0.0.0',
        viewerHostname: 'localhost',
      });

      expect(accessPoints[0]).toMatchObject({
        key: 'public',
        url: 'https://ci-hermes-ci-marketplace-core-2-demopool1.ci.computer',
        state: 'active',
      });
    });

    it('still links a subdomain the operator chose', () => {
      const accessPoints = buildAppAccessPoints({
        ...core2,
        app: { status: 'running', port: 18790, localSubdomain: 'hermes', exposureMode: 'cloudflare', exposedLocal: true } as any,
        info: hermes,
        internalIp: '0.0.0.0',
        viewerHostname: 'localhost',
      });

      expect(accessPoints[0]?.url).toBe('https://hermes-core-2-demopool1.ci.computer');
    });
  });

  describe('Local access link', () => {
    const localApp = { status: 'running', port: 18790, localSubdomain: 'hermes', exposureMode: 'local', openPort: true } as any;
    const base = {
      app: localApp,
      info: { ...info, url_suffix: '' },
      sslPort: 443,
      publicDomain: 'ci.computer',
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    };
    const localUrl = (overrides: { internalIp?: string; viewerHostname?: string }) =>
      buildAppAccessPoints({ ...base, ...overrides }).find((entry) => entry.key === 'local')?.url;

    it('names the host the browser reached the Hub on when the Hub reports only loopback', () => {
      // Viewed over Tailscale, `127.0.0.1` is the viewer's own computer.
      expect(localUrl({ internalIp: '127.0.0.1', viewerHostname: 'core-2.tail1234.ts.net' })).toBe('http://core-2.tail1234.ts.net:18790');
      expect(localUrl({ internalIp: '0.0.0.0', viewerHostname: '192.168.1.40' })).toBe('http://192.168.1.40:18790');
      expect(localUrl({ viewerHostname: 'core-2.local' })).toBe('http://core-2.local:18790');
    });

    it('keeps loopback for a browser running on the Hub itself', () => {
      expect(localUrl({ internalIp: '0.0.0.0', viewerHostname: 'localhost' })).toBe('http://127.0.0.1:18790');
      expect(localUrl({ internalIp: '127.0.0.1', viewerHostname: '127.0.0.1' })).toBe('http://127.0.0.1:18790');
      // The Tauri desktop shell on Windows.
      expect(localUrl({ internalIp: '0.0.0.0', viewerHostname: 'tauri.localhost' })).toBe('http://127.0.0.1:18790');
    });

    it('never names the public hostname, which the tunnel serves on 443 only', () => {
      expect(localUrl({ internalIp: '0.0.0.0', viewerHostname: 'hub-core-2-demopool1.ci.computer' })).toBe('http://127.0.0.1:18790');
    });

    it('keeps a LAN address the Hub reported', () => {
      expect(localUrl({ internalIp: '192.168.1.20', viewerHostname: 'core-2.tail1234.ts.net' })).toBe('http://192.168.1.20:18790');
    });
  });

  it('marks tailscale-only VPN as pending when the app port is not served yet', () => {
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
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
      tailscaleHttpsEnabled: true,
      tailscaleServedPorts: new Set(),
    });

    expect(accessPoints[1]).toMatchObject({
      key: 'vpn',
      state: 'available',
      stateLabel: 'APP_DETAILS_ACCESS_PENDING',
    });
  });
});

describe('AppAccessPoints', () => {
  it('shows a failure toast when clipboard copy fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard unavailable'));
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { toast } = await import('sonner');

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

    const copyButton = screen.getAllByTitle('SETTINGS_GENERAL_COPY')[0];
    if (!copyButton) {
      throw new Error('Expected a copy button to be rendered');
    }
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('SETTINGS_GENERAL_COPY_FAILED');
    });
  });

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
    expect(screen.getByText('https://hub-tailscale-1.example.ts.net:3000/login')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:3000/login')).toBeInTheDocument();
  });

  it('shows the panel for stopped apps including legacy missing status', () => {
    render(
      <AppAccessPoints
        app={
          {
            status: 'missing',
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
  });

  it('offers a QR for routable access points and refuses one for the loopback local URL', () => {
    // `internalIp` is `0.0.0.0` in this suite's app-context mock, so the local
    // entry resolves to `http://127.0.0.1:3000/login` — a URL no phone can dial.
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

    const qrButtons = screen.getAllByLabelText('APP_DETAILS_ACCESS_SHOW_QR');
    expect(qrButtons).toHaveLength(3);

    const [publicQr, vpnQr, localQr] = qrButtons;
    expect(publicQr).toBeEnabled();
    expect(vpnQr).toBeEnabled();
    expect(localQr).toBeDisabled();
    expect(localQr).toHaveAttribute('title', 'APP_DETAILS_ACCESS_QR_LOOPBACK');

    fireEvent.click(publicQr as HTMLElement);

    // The dialog must carry the same URL the card shows, as a scannable code and
    // as selectable text
    expect(screen.getByTitle('COMMON_QR_CODE')).toBeInTheDocument();
    expect(screen.getAllByText('https://openwebui-studio-companion.companionintelligence.com/login').length).toBeGreaterThan(1);
  });
});

describe('isLoopbackAccessUrl', () => {
  it.each([
    'http://127.0.0.1:3000/login',
    'http://127.1.2.3:3000',
    'http://localhost:8080',
    'http://[::1]:3000',
    'http://0.0.0.0:3000',
  ])('treats %s as loopback', (url) => {
    expect(isLoopbackAccessUrl(url)).toBe(true);
  });

  it.each([
    'https://openwebui.example.com/login',
    'http://192.168.1.5:3000',
    'https://hub-tailscale-1.example.ts.net:3000',
  ])('treats %s as routable', (url) => {
    expect(isLoopbackAccessUrl(url)).toBe(false);
  });

  it('does not claim a missing URL is loopback', () => {
    // A null URL means "no route", which the card already handles by disabling
    // every button — it must not be reported as a loopback address.
    expect(isLoopbackAccessUrl(null)).toBe(false);
  });

  it('refuses to share an unparseable URL', () => {
    expect(isLoopbackAccessUrl('not a url')).toBe(true);
  });
});

describe('isMalformedAccessUrl', () => {
  it('separates an unreadable address from a loopback one', () => {
    // Both disable the QR button, but only one of them is a claim about *where*
    // the address points — telling someone a garbled string "only works on this
    // machine" is a fact the card does not have.
    expect(isMalformedAccessUrl('not a url')).toBe(true);
    expect(isLoopbackAccessUrl('not a url')).toBe(true);

    expect(isMalformedAccessUrl('http://127.0.0.1:3000/login')).toBe(false);
    expect(isLoopbackAccessUrl('http://127.0.0.1:3000/login')).toBe(true);
  });

  it.each(['https://openwebui.example.com/login', 'http://192.168.1.5:3000'])('treats %s as readable', (url) => {
    expect(isMalformedAccessUrl(url)).toBe(false);
  });

  it('does not call a missing URL malformed', () => {
    expect(isMalformedAccessUrl(null)).toBe(false);
  });
});

describe('resolveReachableHubHost', () => {
  it('keeps what the Hub reported when there is no viewer to substitute', () => {
    expect(resolveReachableHubHost({ internalIp: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveReachableHubHost({})).toBeUndefined();
  });

  it('normalises the viewer hostname and keeps an IPv6 literal bracketed', () => {
    expect(resolveReachableHubHost({ internalIp: '::', viewerHostname: 'Core-2.Tail1234.ts.net.' })).toBe('core-2.tail1234.ts.net');
    expect(resolveReachableHubHost({ internalIp: '::', viewerHostname: '[fd7a:115c:a1e0::1]' })).toBe('[fd7a:115c:a1e0::1]');
  });

  it('treats the IPv6 loopback as the Hub itself', () => {
    expect(resolveReachableHubHost({ internalIp: '::1', viewerHostname: '[::1]' })).toBe('::1');
  });

  it('matches the public domain itself, not just names under it', () => {
    expect(resolveReachableHubHost({ internalIp: '0.0.0.0', viewerHostname: 'ci.computer', publicDomain: 'ci.computer' })).toBe('0.0.0.0');
    expect(resolveReachableHubHost({ internalIp: '0.0.0.0', viewerHostname: 'notci.computer', publicDomain: 'ci.computer' })).toBe('notci.computer');
  });
});
