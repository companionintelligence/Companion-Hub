import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  access: vi.fn(),
  constants: { X_OK: 1, R_OK: 4, W_OK: 2 },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, 'mock-api-key', '');
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { HeadscaleService } from '../headscale.service';

describe('HeadscaleService', () => {
  let service: HeadscaleService;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HEADSCALE_AUTO_BOOTSTRAP;
    service = new HeadscaleService();
  });

  afterEach(() => {
    delete process.env.HEADSCALE_AUTO_BOOTSTRAP;
    delete process.env.HEADSCALE_PUBLIC_URL;
    delete process.env.HEADSCALE_PUBLIC_HOST;
    delete process.env.DOMAIN;
    delete process.env.PRIVATE_VPN_ENABLED;
  });

  describe('resolveHeadscaleServerUrlFromEnv', () => {
    it('returns origin from HEADSCALE_PUBLIC_URL', () => {
      process.env.HEADSCALE_PUBLIC_URL = 'https://headscale.example.com/some/path';
      expect(HeadscaleService.resolveHeadscaleServerUrlFromEnv()).toBe('https://headscale.example.com');
    });

    it('returns https URL from HEADSCALE_PUBLIC_HOST', () => {
      process.env.HEADSCALE_PUBLIC_HOST = 'headscale.ci.computer';
      expect(HeadscaleService.resolveHeadscaleServerUrlFromEnv()).toBe('https://headscale.ci.computer');
    });

    it('strips scheme from HEADSCALE_PUBLIC_HOST', () => {
      process.env.HEADSCALE_PUBLIC_HOST = 'https://headscale.ci.computer';
      expect(HeadscaleService.resolveHeadscaleServerUrlFromEnv()).toBe('https://headscale.ci.computer');
    });

    it('falls back to internal Docker URL when unset', () => {
      expect(HeadscaleService.resolveHeadscaleServerUrlFromEnv()).toBe('http://headscale:8080');
    });

    it('falls back on invalid HEADSCALE_PUBLIC_URL', () => {
      process.env.HEADSCALE_PUBLIC_URL = 'not-a-url';
      expect(HeadscaleService.resolveHeadscaleServerUrlFromEnv()).toBe('http://headscale:8080');
    });

    it('returns https://headscale.<DOMAIN> when only DOMAIN is set', () => {
      process.env.DOMAIN = 'example.com';
      expect(HeadscaleService.resolveHeadscaleServerUrlFromEnv()).toBe('https://headscale.example.com');
    });

    it('prefers HEADSCALE_PUBLIC_HOST over DOMAIN', () => {
      process.env.DOMAIN = 'other.com';
      process.env.HEADSCALE_PUBLIC_HOST = 'hs.example.com';
      expect(HeadscaleService.resolveHeadscaleServerUrlFromEnv()).toBe('https://hs.example.com');
    });
  });

  describe('getClientInfo', () => {
    it('sets publicConfigured when HEADSCALE_PUBLIC_HOST is set', async () => {
      process.env.HEADSCALE_PUBLIC_HOST = 'headscale.ci.computer';
      const info = await service.getClientInfo();
      expect(info.publicConfigured).toBe(true);
      expect(info.loginServerUrl).toBe('https://headscale.ci.computer');
    });

    it('sets publicConfigured when HEADSCALE_PUBLIC_URL is set', async () => {
      process.env.HEADSCALE_PUBLIC_URL = 'https://hs.example.com';
      const info = await service.getClientInfo();
      expect(info.publicConfigured).toBe(true);
      expect(info.loginServerUrl).toBe('https://hs.example.com');
    });

    it('sets publicConfigured false when no public env', async () => {
      const info = await service.getClientInfo();
      expect(info.publicConfigured).toBe(false);
      expect(info.loginServerUrl).toBe('http://headscale:8080');
    });

    it('sets publicConfigured when DOMAIN implies headscale subdomain', async () => {
      process.env.DOMAIN = 'example.com';
      const info = await service.getClientInfo();
      expect(info.publicConfigured).toBe(true);
      expect(info.loginServerUrl).toBe('https://headscale.example.com');
    });

    it('getClientInfo returns disabled when PRIVATE_VPN_ENABLED=false', async () => {
      process.env.PRIVATE_VPN_ENABLED = 'false';
      process.env.DOMAIN = 'example.com';
      const info = await service.getClientInfo();
      expect(info.publicConfigured).toBe(false);
      expect(info.loginServerUrl).toBe('http://headscale:8080');
    });
  });

  describe('isHealthy', () => {
    it('returns true when headscale API responds OK', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      expect(await service.isHealthy()).toBe(true);
    });

    it('returns false when headscale API is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await service.isHealthy()).toBe(false);
    });
  });

  describe('getTailscaleStatus', () => {
    it('returns connected when hub-tailscale node is online', async () => {
      service.setApiKey('test-key');
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              {
                id: '1',
                name: 'hub-tailscale',
                ipAddresses: ['100.64.0.1'],
                online: true,
                lastSeen: '2025-01-01T00:00:00Z',
                createdAt: '2025-01-01T00:00:00Z',
                user: 'hub',
              },
            ],
          }),
      });

      const status = await service.getTailscaleStatus();
      expect(status.connected).toBe(true);
      expect(status.ip).toBe('100.64.0.1');
    });

    it('returns disconnected when API unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const status = await service.getTailscaleStatus();
      expect(status.connected).toBe(false);
      expect(status.ip).toBeNull();
    });
  });

  describe('ensureHubTailscaleJoined', () => {
    it('returns skipped when HEADSCALE_AUTO_BOOTSTRAP is false', async () => {
      process.env.HEADSCALE_AUTO_BOOTSTRAP = 'false';
      await expect(service.ensureHubTailscaleJoined()).resolves.toBe('skipped');
    });

    it('returns done when hub-tailscale is already online', async () => {
      service.setApiKey('test-key');
      mockFetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              {
                id: '1',
                name: 'hub-tailscale',
                ipAddresses: ['100.64.0.1'],
                online: true,
                lastSeen: '2025-01-01T00:00:00Z',
                createdAt: '2025-01-01T00:00:00Z',
                user: 'hub',
              },
            ],
          }),
      });

      await expect(service.ensureHubTailscaleJoined()).resolves.toBe('done');
    });
  });

  describe('isPrivateVpnReady', () => {
    it('returns true when headscale is healthy and hub-tailscale is online', async () => {
      service.setApiKey('test-key');
      const nodesResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              {
                id: '1',
                name: 'hub-tailscale',
                ipAddresses: ['100.64.0.1'],
                online: true,
                lastSeen: '2025-01-01T00:00:00Z',
                createdAt: '2025-01-01T00:00:00Z',
                user: 'hub',
              },
            ],
          }),
      };

      mockFetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(nodesResponse);

      await expect(service.isPrivateVpnReady()).resolves.toBe(true);
    });

    it('returns false when headscale is unhealthy', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.isPrivateVpnReady()).resolves.toBe(false);
    });

    it('returns false when hub-tailscale is offline', async () => {
      service.setApiKey('test-key');
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              nodes: [
                {
                  id: '1',
                  name: 'hub-tailscale',
                  ipAddresses: ['100.64.0.1'],
                  online: false,
                  lastSeen: '2025-01-01T00:00:00Z',
                  createdAt: '2025-01-01T00:00:00Z',
                  user: 'hub',
                },
              ],
            }),
        });

      await expect(service.isPrivateVpnReady()).resolves.toBe(false);
    });
  });

  describe('getVpnStatus', () => {
    it('aggregates headscale and tailscale status', async () => {
      service.setApiKey('test-key');
      const nodesResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              {
                id: '1',
                name: 'hub-tailscale',
                ipAddresses: ['100.64.0.1'],
                online: true,
                lastSeen: '2025-01-01T00:00:00Z',
                createdAt: '2025-01-01T00:00:00Z',
                user: 'hub',
              },
            ],
          }),
      };

      mockFetch
        .mockResolvedValueOnce({ ok: true }) // health check
        .mockResolvedValueOnce(nodesResponse) // getTailscaleStatus -> listDevices
        .mockResolvedValueOnce(nodesResponse); // listDevices for deviceCount

      const status = await service.getVpnStatus();
      expect(status.enabled).toBe(true);
      expect(status.headscaleHealthy).toBe(true);
      expect(status.tailscaleConnected).toBe(true);
      expect(status.deviceCount).toBe(1);
    });
  });

  describe('listDevices', () => {
    it('returns mapped device list', async () => {
      service.setApiKey('test-key');
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              {
                id: '1',
                name: 'hub-tailscale',
                givenName: 'hub-tailscale',
                ipAddresses: ['100.64.0.1'],
                online: true,
                lastSeen: '2025-01-01T00:00:00Z',
                createdAt: '2025-01-01T00:00:00Z',
                user: 'hub',
              },
            ],
          }),
      });

      const devices = await service.listDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].name).toBe('hub-tailscale');
      expect(devices[0].online).toBe(true);
    });
  });

  describe('createPreAuthKey', () => {
    it('creates a pre-auth key with defaults', async () => {
      service.setApiKey('test-key');
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            preAuthKey: {
              id: '1',
              key: 'tskey-preauth-abc123',
              reusable: false,
              ephemeral: false,
              used: false,
              expiration: '2025-01-02T00:00:00Z',
              createdAt: '2025-01-01T00:00:00Z',
              user: 'hub',
            },
          }),
      });

      const key = await service.createPreAuthKey();
      expect(key.key).toBe('tskey-preauth-abc123');
      expect(key.reusable).toBe(false);
    });
  });
});
