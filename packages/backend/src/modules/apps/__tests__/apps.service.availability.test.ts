import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppsService } from '../apps.service';
import type { AppUrn } from '@ci-hub/common/types';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { TailscaleService } from '../../tailscale/tailscale.service';

// Mock axios
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

import axios from 'axios';
const mockedAxiosGet = vi.mocked(axios.get);

// Helpers to build mock dependencies
const createMockService = () => {
  const mockApp = {
    id: 1,
    appName: 'test-app',
    appStoreSlug: 'test-store',
    status: 'running',
    localSubdomain: 'testapp',
    port: 8080,
    exposureMode: 'local',
    config: {},
  };

  const mockInfo = {
    id: 'test-app',
    urn: 'test-app:test-store',
    url_suffix: '',
    no_gui: false,
  };

  const mockConfig = {
    localDomain: 'ci.lan',
    userSettings: {
      internalIp: '192.168.1.100',
      sslPort: 443,
      domain: 'example.com',
      localDomain: 'ci.lan',
      ciHubOrganizationSlug: 'myorg',
    },
  };

  const mockOrg = {
    slug: 'myorg',
    hubSubdomain: 'hub-device1-myorg',
  };

  // Create partial mock of AppsService with getApp and config mocked
  const service = Object.create(AppsService.prototype) as AppsService;

  // Mock internal dependencies
  const getAppMock = vi.fn().mockResolvedValue({ app: mockApp, info: mockInfo });
  const getConfigMock = vi.fn().mockReturnValue(mockConfig);
  const getDeviceRegMock = vi.fn().mockResolvedValue(mockOrg);
  const cloudflareClient = { getTunnelToken: () => 'token' };
  const tailscaleService = {
    getStatus: vi.fn().mockResolvedValue({
      installed: true,
      connected: true,
      hostname: 'hub-tailscale-1',
      nodeFqdn: 'hub-tailscale-1.example.ts.net',
      tailnet: 'example.ts.net',
      supportsServices: true,
    }),
  };
  const moduleRefMock = {
    get: vi.fn((token: unknown) => {
      if (token === CloudflareClientService) return cloudflareClient;
      if (token === TailscaleService) return tailscaleService;
      return undefined;
    }),
  };

  // Assign mocked private dependencies
  (service as any).configurationService = { getConfig: getConfigMock };
  (service as any).registrationService = { getDeviceRegistrationInfo: getDeviceRegMock };
  (service as any).moduleRef = moduleRefMock;
  (service as any).appsReadService = { getApp: getAppMock };

  return { service, mockApp, mockInfo, mockConfig, mockOrg, getAppMock, getConfigMock, getDeviceRegMock, moduleRefMock, tailscaleService };
};

describe('AppsService.checkAppAvailability', () => {
  let ctx: ReturnType<typeof createMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockService();
  });

  // Test 1: local mode → returns available immediately without HTTP check
  it('local mode → returns available immediately without HTTP check', async () => {
    ctx.mockApp.exposureMode = 'local';
    ctx.mockApp.openPort = true;
    ctx.mockApp.port = 3000;

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.stage).toBe('ready');
    expect(result.appUrl).toBe('http://192.168.1.100:3000');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  // Test 1b: local mode maps 0.0.0.0 internal IP to localhost for browser URLs
  it('local mode maps 0.0.0.0 internal IP to 127.0.0.1', async () => {
    ctx.mockApp.exposureMode = 'local';
    ctx.mockApp.openPort = true;
    ctx.mockApp.port = 3000;
    ctx.mockConfig.userSettings.internalIp = '0.0.0.0';

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.appUrl).toBe('http://127.0.0.1:3000');
  });

  // Test 1c: local mode without openPort still uses host port URL
  it('local mode without openPort → uses host port URL', async () => {
    ctx.mockApp.exposureMode = 'local';
    ctx.mockApp.openPort = false;
    ctx.mockApp.port = 3000;

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.appUrl).toBe('http://192.168.1.100:3000');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('local mode brackets IPv6 loopback for browser URLs', async () => {
    ctx.mockApp.exposureMode = 'local';
    ctx.mockApp.openPort = true;
    ctx.mockApp.port = 3000;
    ctx.mockConfig.userSettings.internalIp = '::1';

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.appUrl).toBe('http://[::1]:3000');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  describe('an app whose host port stays on loopback', () => {
    beforeEach(() => {
      Object.assign(ctx.mockInfo, { exposable: true, hub_integration: { mcp_client: true } });
      ctx.mockApp.port = 18789;
    });

    it('opens on loopback in local mode, since the LAN address refuses the connection', async () => {
      ctx.mockApp.exposureMode = 'local';

      const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

      expect(result.available).toBe(true);
      expect(result.appUrl).toBe('http://127.0.0.1:18789');
      // Nor is the LAN address offered as the "Open on local network" alternative.
      expect(result.localUrl).toBeUndefined();
      expect(mockedAxiosGet).not.toHaveBeenCalled();
    });

    it('falls back to loopback, not the LAN, when a cloudflare app has no tunnel token', async () => {
      ctx.mockApp.exposureMode = 'cloudflare';
      Object.assign(ctx.mockApp, { exposedLocal: true });
      ctx.moduleRefMock.get.mockReturnValue({ getTunnelToken: () => null });

      const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

      expect(result.appUrl).toBe('http://127.0.0.1:18789');
      expect(result.localUrl).toBeUndefined();
    });
  });

  // Test 2: local mode without port → unavailable
  it('local mode without port → unavailable', async () => {
    ctx.mockApp.exposureMode = 'local';
    ctx.mockApp.openPort = false;
    ctx.mockApp.port = 0;

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(result.stage).toBe('error');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  // Test 3: cloudflare mode → constructs correct subdomain with deviceSlug
  it('cloudflare mode → constructs correct subdomain with deviceSlug', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.mockApp.localSubdomain = 'myapp';

    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.appUrl).toBe('https://myapp-device1-myorg.example.com');
  });

  it('cloudflare mode without tunnel token falls back to local app URL when a host port exists', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.mockApp.localSubdomain = 'myapp';
    ctx.mockApp.exposedLocal = true;
    ctx.moduleRefMock.get.mockReturnValue({ getTunnelToken: () => null });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.stage).toBe('ready');
    expect(result.appUrl).toBe('http://192.168.1.100:8080');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('cloudflare mode without tunnel token does not fall back to localhost when no host port is published', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.mockApp.localSubdomain = 'myapp';
    ctx.mockApp.exposedLocal = false;
    ctx.mockApp.openPort = false;
    ctx.moduleRefMock.get.mockReturnValue({ getTunnelToken: () => null });
    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.stage).toBe('ready');
    expect(result.appUrl).toBe('https://myapp-device1-myorg.example.com');
    expect(mockedAxiosGet).toHaveBeenCalledWith('https://myapp-device1-myorg.example.com', expect.any(Object));
  });

  it('cloudflare mode falls back to appName-storeSlug when localSubdomain is missing', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.mockApp.localSubdomain = null;
    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.appUrl).toBe('https://test-app-test-store-device1-myorg.example.com');
  });

  // Test 4: cloudflare mode without hubSubdomain → returns NO_DEVICE_REGISTRATION error
  it('cloudflare mode without hubSubdomain → returns NO_DEVICE_REGISTRATION', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.getDeviceRegMock.mockResolvedValue({ slug: 'myorg', hubSubdomain: undefined });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(result.errorCode).toBe('NO_DEVICE_REGISTRATION');
    expect(result.resolvable).toBe(false);
  });

  // Test 5: cloudflare mode → any HTTP 2xx response = available
  it('cloudflare mode → HTTP 200 = available', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'Hello' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.stage).toBe('ready');
  });

  // Test 6: HTTP 301/302/401/403 = available (not just 2xx)
  for (const status of [301, 302, 401, 403]) {
    it(`cloudflare mode → HTTP ${status} = available`, async () => {
      ctx.mockApp.exposureMode = 'cloudflare';
      mockedAxiosGet.mockResolvedValue({ status, data: 'Redirected or forbidden' });

      const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

      expect(result.available).toBe(true);
      expect(result.httpStatus).toBe(status);
    });
  }

  // Test 7: Cloudflare error 1033 = CF_TUNNEL_NOT_FOUND
  it('cloudflare mode → CF error 1033 = CF_TUNNEL_NOT_FOUND, resolvable, includes appUrl', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    mockedAxiosGet.mockResolvedValue({
      status: 530,
      data: '<html>Cloudflare Ray ID abc123 <span class="cf-error-details">Error 1033</span></html>',
    });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(result.errorCode).toBe('CF_TUNNEL_NOT_FOUND');
    expect(result.resolvable).toBe(true);
    expect(result.appUrl).toBeDefined();
    expect(result.stage).toBe('propagating');
  });

  // Test 8: Cloudflare 502 = CF_UPSTREAM_ERROR
  it('cloudflare mode → CF 502 = CF_UPSTREAM_ERROR, resolvable, includes appUrl', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    mockedAxiosGet.mockResolvedValue({
      status: 502,
      data: '<html>Cloudflare Ray ID abc123 Error 502</html>',
    });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(result.errorCode).toBe('CF_UPSTREAM_ERROR');
    expect(result.resolvable).toBe(true);
    expect(result.appUrl).toBeDefined();
    expect(result.stage).toBe('propagating');
  });

  // Test 9: DNS ENOTFOUND = DNS_NOT_FOUND
  it('cloudflare mode → DNS ENOTFOUND = DNS_NOT_FOUND, resolvable, includes appUrl', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    mockedAxiosGet.mockRejectedValue(new Error('getaddrinfo ENOTFOUND myapp.example.com'));

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(result.errorCode).toBe('DNS_NOT_FOUND');
    expect(result.resolvable).toBe(true);
    expect(result.appUrl).toBeDefined();
    expect(result.stage).toBe('propagating');
  });

  it('tailscale mode → uses node MagicDNS hostname with the app vpn port', async () => {
    ctx.mockApp.exposureMode = 'tailscale';
    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'ok' } as never);

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(ctx.tailscaleService.getStatus).toHaveBeenCalled();
    expect(result.available).toBe(true);
    expect(result.appUrl).toBe('https://hub-tailscale-1.example.ts.net:8080');
  });

  // Test 10: connection refused = CONNECTION_REFUSED
  it('cloudflare mode → ECONNREFUSED = CONNECTION_REFUSED, resolvable, includes appUrl', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    mockedAxiosGet.mockRejectedValue(new Error('connect ECONNREFUSED 1.2.3.4:443'));

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(result.errorCode).toBe('CONNECTION_REFUSED');
    expect(result.resolvable).toBe(true);
    expect(result.appUrl).toBeDefined();
  });

  // Test 11: timeout = CONNECTION_TIMEOUT, not resolvable
  it('cloudflare mode → timeout = CONNECTION_TIMEOUT, not resolvable, includes appUrl', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    mockedAxiosGet.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(result.errorCode).toBe('CONNECTION_TIMEOUT');
    expect(result.resolvable).toBe(false);
    expect(result.appUrl).toBeDefined();
    expect(result.stage).toBe('error');
  });

  // Test 12: stage values
  it('stage is ready when available, propagating for transient, error for permanent', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';

    // Ready
    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });
    let result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);
    expect(result.stage).toBe('ready');

    // Propagating (DNS)
    mockedAxiosGet.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);
    expect(result.stage).toBe('propagating');

    // Error (timeout)
    mockedAxiosGet.mockRejectedValue(new Error('ETIMEDOUT'));
    result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);
    expect(result.stage).toBe('error');
  });

  // Test 13: app not running → returns available: false
  it('app not running → returns available: false', async () => {
    ctx.mockApp.status = 'stopped';

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(false);
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  // Test 14: app.publicDomain overrides userSettings.domain in the constructed URL
  it('cloudflare mode → app.publicDomain used in appUrl instead of userSettings.domain', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.mockApp.localSubdomain = 'myapp';
    (ctx.mockApp as any).publicDomain = 'lifescope.io';

    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.appUrl).toBe('https://myapp-device1-myorg.lifescope.io');
    // Should NOT use the device-default example.com
    expect(result.appUrl).not.toContain('example.com');
  });

  // Test 15: app.publicDomain absent → falls back to userSettings.domain
  it('cloudflare mode → falls back to userSettings.domain when app.publicDomain is absent', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.mockApp.localSubdomain = 'myapp';
    (ctx.mockApp as any).publicDomain = null;

    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.appUrl).toBe('https://myapp-device1-myorg.example.com');
  });

  // Test 16: app.publicDomain set but no userSettings.domain → still works
  it('cloudflare mode → available when only app.publicDomain is set (no device default domain)', async () => {
    ctx.mockApp.exposureMode = 'cloudflare';
    ctx.mockApp.localSubdomain = 'myapp';
    (ctx.mockApp as any).publicDomain = 'lifescope.io';
    ctx.mockConfig.userSettings.domain = '';

    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.appUrl).toContain('lifescope.io');
  });
});
