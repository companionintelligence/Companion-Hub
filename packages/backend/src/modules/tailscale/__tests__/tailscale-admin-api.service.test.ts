import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TailscaleAdminApiService } from '../tailscale-admin-api.service';

describe('TailscaleAdminApiService', () => {
  const originalEnv = { ...process.env };
  let service: TailscaleAdminApiService;

  beforeEach(() => {
    service = new TailscaleAdminApiService();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('is false when the OAuth client id/secret are not set', () => {
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
      delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;

      expect(service.isConfigured()).toBe(false);
    });

    it('is true once both env vars are set', () => {
      process.env.TAILSCALE_OAUTH_CLIENT_ID = 'client-id';
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = 'client-secret';

      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('listDevices', () => {
    beforeEach(() => {
      process.env.TAILSCALE_OAUTH_CLIENT_ID = 'client-id';
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = 'client-secret';
    });

    it('throws a clear error when the OAuth credentials are missing', async () => {
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;

      await expect(service.listDevices('tailxyz.ts.net')).rejects.toThrow(/not configured/);
    });

    it('exchanges the OAuth token then lists devices for the tailnet', async () => {
      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              devices: [
                {
                  id: 'dev-1',
                  nodeId: 'n1',
                  hostname: 'hub-a',
                  name: 'hub-a.tailxyz.ts.net',
                  addresses: ['100.64.0.1'],
                  os: 'linux',
                  tags: ['tag:hub'],
                },
              ],
            }),
            { status: 200 },
          ),
        );

      const devices = await service.listDevices('tailxyz.ts.net');

      expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.tailscale.com/api/v2/oauth/token', expect.objectContaining({ method: 'POST' }));
      const listCall = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(listCall[0]).toBe('https://api.tailscale.com/api/v2/tailnet/tailxyz.ts.net/devices?fields=all');
      expect((listCall[1].headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
      expect(devices).toEqual([
        {
          id: 'dev-1',
          nodeId: 'n1',
          hostname: 'hub-a',
          name: 'hub-a.tailxyz.ts.net',
          addresses: ['100.64.0.1'],
          os: 'linux',
          clientVersion: '',
          lastSeen: null,
          tags: ['tag:hub'],
        },
      ]);
    });

    it('reuses the cached token across calls until it expires', async () => {
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), { status: 200 }));
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), { status: 200 }));
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ devices: [] }), { status: 200 }));
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ devices: [] }), { status: 200 }));

      await service.listDevices('tailxyz.ts.net');
      await service.listDevices('tailxyz.ts.net');

      // One token exchange + two device listings = 3 calls, not 4 — the second `listDevices` must
      // not re-request a token that hasn't expired yet.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws when the tailnet devices request fails', async () => {
      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), { status: 200 }))
        .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

      await expect(service.listDevices('tailxyz.ts.net')).rejects.toThrow(/403/);
    });
  });
});
