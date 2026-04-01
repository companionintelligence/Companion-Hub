import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppsService } from '../apps.service';
import type { AppUrn } from '@ci-hub/common/types';

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
    userSettings: {
      internalIp: '192.168.1.100',
      sslPort: 443,
      domain: 'example.com',
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

  // Assign mocked private dependencies
  (service as any).configurationService = { getConfig: getConfigMock };
  (service as any).registrationService = { getDeviceRegistrationInfo: getDeviceRegMock };

  // Override getApp
  (service as any).getApp = getAppMock;

  return { service, mockApp, mockInfo, mockConfig, mockOrg, getAppMock, getConfigMock, getDeviceRegMock };
};

describe('AppsService.checkAppAvailability', () => {
  let ctx: ReturnType<typeof createMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockService();
  });

  // Test 1: local mode with port → returns available immediately without HTTP check
  it('local mode with port → returns available immediately without HTTP check', async () => {
    ctx.mockApp.exposureMode = 'local';
    ctx.mockApp.port = 3000;

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.stage).toBe('ready');
    expect(result.appUrl).toBe('http://192.168.1.100:3000');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  // Test 2: local mode without port → falls back to sslPort
  it('local mode without port → falls back to sslPort', async () => {
    ctx.mockApp.exposureMode = 'local';
    ctx.mockApp.port = 0; // falsy

    mockedAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await ctx.service.checkAppAvailability('test-app:test-store' as AppUrn);

    expect(result.available).toBe(true);
    expect(result.appUrl).toContain(':443');
    expect(mockedAxiosGet).toHaveBeenCalled();
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
});
