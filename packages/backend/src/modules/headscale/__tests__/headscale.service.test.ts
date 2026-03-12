import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
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
    service = new HeadscaleService();
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
