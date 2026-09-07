import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { MAX_MANUAL_POOL_CANDIDATES, POOL_PROBE_MISS_THRESHOLD } from '@/common/helpers/hub-pool-probe';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolDiscoveryService, mergePoolCandidates } from '../hub-pool-discovery.service';
import type { DiscoverablePoolPeer } from '../hub-pool.types';
import type { PortalClientService } from '@/core/portal/portal-client.service';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    displayName: null,
    direction: 'outbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: null,
    lastCapabilities: null,
    verifyTokenHash: null,
    presentTokenEncrypted: null,
    peerNodeUuid: null,
    peerPublicKey: null,
    bearerGraceUntil: null,
    signedSeenAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** An `/identify` answer from a real Hub. */
function identifyResponse(nodeFqdn: string | null): Response {
  return { ok: true, json: async () => ({ isCiHub: true, nodeFqdn }) } as unknown as Response;
}

describe('mergePoolCandidates', () => {
  const tailscaleEntry: DiscoverablePoolPeer = {
    tailscaleDeviceId: 'ts-1',
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    hostname: 'peer-hub',
    source: 'tailscale',
  };
  const manualEntry: DiscoverablePoolPeer = {
    tailscaleDeviceId: '',
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    hostname: 'peer-hub',
    source: 'lan-probe',
  };

  it('offers a node reachable both ways exactly once', () => {
    const merged = mergePoolCandidates([tailscaleEntry], [manualEntry]);
    expect(merged).toEqual([tailscaleEntry]);
  });

  it('keeps the Tailscale entry on a merge, because its name is what the transport dials', () => {
    const merged = mergePoolCandidates([tailscaleEntry], [manualEntry]);
    expect(merged[0]?.source).toBe('tailscale');
  });

  it('merges on the normalized FQDN, so a trailing dot or different case is the same node', () => {
    const trailingDot: DiscoverablePoolPeer = { ...manualEntry, nodeFqdn: 'peer-hub.tailxyz.ts.net.' };
    const upperCase: DiscoverablePoolPeer = { ...manualEntry, nodeFqdn: 'PEER-HUB.tailxyz.ts.net' };

    expect(mergePoolCandidates([tailscaleEntry], [trailingDot])).toEqual([tailscaleEntry]);
    expect(mergePoolCandidates([tailscaleEntry], [upperCase])).toEqual([tailscaleEntry]);
  });

  it('never merges two genuinely different nodes', () => {
    const other: DiscoverablePoolPeer = { ...manualEntry, nodeFqdn: 'different-hub.tailxyz.ts.net', hostname: 'different-hub' };
    expect(mergePoolCandidates([tailscaleEntry], [other])).toHaveLength(2);
  });

  it('does NOT key on a UUID the candidate claims about itself', () => {
    // `/identify` is unauthenticated, so anything reachable on the network can claim any UUID. If
    // the merge keyed on one, a hostile box could claim a real node's UUID and suppress that node
    // from the operator's candidate list — or graft itself onto the entry the operator then pairs
    // with. Only the FQDN, which the tailnet control plane also attests, is a merge key.
    const impostor: DiscoverablePoolPeer = {
      tailscaleDeviceId: '',
      nodeFqdn: 'attacker-box.tailxyz.ts.net',
      hostname: 'attacker-box',
      source: 'lan-probe',
      claimedNodeUuid: 'a-uuid-copied-from-the-real-peer',
    };
    const real: DiscoverablePoolPeer = { ...tailscaleEntry, claimedNodeUuid: 'a-uuid-copied-from-the-real-peer' };

    const merged = mergePoolCandidates([real], [impostor]);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.nodeFqdn)).toContain('peer-hub.tailxyz.ts.net');
  });

  it('back-fills a Tailscale device id onto a manual-only entry when one turns up', () => {
    const merged = mergePoolCandidates([], [manualEntry, { ...manualEntry, tailscaleDeviceId: 'ts-1' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.tailscaleDeviceId).toBe('ts-1');
  });

  it('is a no-op on the Tailscale-only list every single-node Hub sees', () => {
    expect(mergePoolCandidates([tailscaleEntry], [])).toEqual([tailscaleEntry]);
    expect(mergePoolCandidates([], [])).toEqual([]);
  });
});

describe('HubPoolDiscoveryService', () => {
  let repo: MockProxy<HubPoolPeerRepository>;
  let peerService: MockProxy<HubPoolPeerService>;
  let tailscaleService: MockProxy<TailscaleService>;
  let portalClient: MockProxy<PortalClientService>;
  let service: HubPoolDiscoveryService;

  beforeEach(() => {
    repo = mock<HubPoolPeerRepository>();
    peerService = mock<HubPoolPeerService>();
    tailscaleService = mock<TailscaleService>();
    lookup.mockReset();

    repo.listAll.mockResolvedValue([]);
    repo.findByNodeFqdn.mockResolvedValue(undefined);
    peerService.listDiscoverableDevices.mockResolvedValue([]);
    tailscaleService.getStatusCached.mockResolvedValue({
      installed: true,
      connected: true,
      version: '1.90.0',
      hostname: 'self-hub',
      nodeFqdn: 'self-hub.tailxyz.ts.net',
      tailnet: 'tailxyz.ts.net',
      ip: '100.64.0.1',
      supportsServices: true,
      httpsAvailable: true,
      backendState: 'Running',
      authUrl: null,
    });
    portalClient = mock<PortalClientService>();
    portalClient.fetchDispatchDevices.mockResolvedValue([]);

    service = new HubPoolDiscoveryService(mock<LoggerService>(), repo, peerService, tailscaleService, portalClient);
    global.fetch = vi.fn();
  });

  describe('probeAddress', () => {
    it("turns a LAN address into the node's tailnet FQDN, which is what pairing then uses", async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));

      const result = await service.probeAddress('192.168.1.42');

      expect(result).toMatchObject({
        isCiHub: true,
        nodeFqdn: 'peer-hub.tailxyz.ts.net',
        hostname: 'peer-hub',
        pairable: true,
        alreadyPaired: false,
        reason: null,
      });
    });

    it('walks the port fallbacks, because the container API_PORT is not the published one', async () => {
      vi.mocked(global.fetch)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(identifyResponse('peer-hub.tailxyz.ts.net'));

      const result = await service.probeAddress('192.168.1.42');

      expect(result.pairable).toBe(true);
      expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe('http://192.168.1.42:5002/api/inference/pool/identify');
      expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toBe('https://192.168.1.42:5002/api/inference/pool/identify');
      expect(vi.mocked(global.fetch).mock.calls[2]?.[0]).toBe('http://192.168.1.42:3000/api/inference/pool/identify');
    });

    it('uses only the port the operator typed, when they typed one', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));

      await service.probeAddress('192.168.1.42:5010');

      expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe('http://192.168.1.42:5010/api/inference/pool/identify');
    });

    it('refuses a public address rather than fetching it', async () => {
      await expect(service.probeAddress('93.184.216.34')).rejects.toThrow(BadRequestException);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses loopback and the cloud metadata endpoint', async () => {
      // `isPrivateOrLocalIp` would allow both. This route is a prober, so it gets the narrower list.
      await expect(service.probeAddress('127.0.0.1:5002')).rejects.toThrow(BadRequestException);
      await expect(service.probeAddress('169.254.169.254')).rejects.toThrow(BadRequestException);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses a hostname that resolves anywhere public, even partly', async () => {
      lookup.mockResolvedValue([
        { address: '192.168.1.42', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]);

      await expect(service.probeAddress('rebind.example.com')).rejects.toThrow(BadRequestException);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('probes a hostname that resolves entirely inside the LAN', async () => {
      lookup.mockResolvedValue([{ address: '192.168.1.42', family: 4 }]);
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));

      await expect(service.probeAddress('mini-pc.lan')).resolves.toMatchObject({ pairable: true });
    });

    it('rejects an unparseable address with a message naming the shapes that work', async () => {
      await expect(service.probeAddress('http://192.168.1.42/admin')).rejects.toThrow(/192\.168\.1\.42/);
    });

    it('reports an address that answers nothing as unreachable, not as an error', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.probeAddress('192.168.1.99');

      expect(result).toMatchObject({ isCiHub: false, pairable: false, reason: 'unreachable' });
    });

    it('reports something that is not a Hub distinctly from something unreachable', async () => {
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ hello: 'world' }) } as unknown as Response);

      const result = await service.probeAddress('192.168.1.50');

      expect(result).toMatchObject({ isCiHub: false, reason: 'not_a_hub' });
    });

    it('reports a Hub with no tailnet name as found but not pairable', async () => {
      // There is no name to build `https://<fqdn>` from, so there is nothing to pair with — but
      // saying "found it, and here is why you cannot use it" is the whole point of the distinction.
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse(null));

      const result = await service.probeAddress('192.168.1.42');

      expect(result).toMatchObject({ isCiHub: true, nodeFqdn: null, pairable: false, reason: 'no_tailnet_fqdn' });
    });

    it('recognises this node itself instead of offering a self-pairing', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('self-hub.tailxyz.ts.net'));

      const result = await service.probeAddress('192.168.1.10');

      expect(result).toMatchObject({ pairable: false, reason: 'self' });
    });

    it('reports an already-paired node and does not offer it again', async () => {
      repo.findByNodeFqdn.mockResolvedValue(mockPeer());
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));

      const result = await service.probeAddress('192.168.1.42');

      expect(result).toMatchObject({ alreadyPaired: true, pairable: false, reason: 'already_paired' });
      expect(await service.listDiscoverableNodes()).toEqual([]);
    });
  });

  describe('listDiscoverableNodes', () => {
    it('remembers a probed node so the operator types the address once', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.probeAddress('192.168.1.42');

      const candidates = await service.listDiscoverableNodes();

      expect(candidates).toEqual([{ tailscaleDeviceId: '', nodeFqdn: 'peer-hub.tailxyz.ts.net', hostname: 'peer-hub', source: 'lan-probe' }]);
    });

    it('leaves Tailscale Admin API discovery completely unchanged', async () => {
      // This is what lets a pool span networks, which is the genuine advantage over a LAN-only
      // design. Manual entry is an addition to it, never a replacement.
      peerService.listDiscoverableDevices.mockResolvedValue([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'remote-hub.tailxyz.ts.net', hostname: 'remote-hub' },
      ]);

      const candidates = await service.listDiscoverableNodes();

      expect(candidates).toEqual([{ tailscaleDeviceId: 'ts-1', nodeFqdn: 'remote-hub.tailxyz.ts.net', hostname: 'remote-hub', source: 'tailscale' }]);
    });

    it('offers a node found by both sources exactly once', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.probeAddress('192.168.1.42');
      peerService.listDiscoverableDevices.mockResolvedValue([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', hostname: 'peer-hub' },
      ]);

      const candidates = await service.listDiscoverableNodes();

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ tailscaleDeviceId: 'ts-1', source: 'tailscale' });
    });

    it('issues no network calls at all when there is nothing to refresh', async () => {
      // The guarantee that matters most: a single-node Hub with no peers and no candidates is
      // completely unaffected by this feature.
      await service.listDiscoverableNodes();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('keeps a candidate that misses fewer than three refreshes running', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.probeAddress('192.168.1.42');

      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await service.listDiscoverableNodes()).toHaveLength(1);
      expect(await service.listDiscoverableNodes()).toHaveLength(1);
    });

    it('drops a candidate after three consecutive misses', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.probeAddress('192.168.1.42');

      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < POOL_PROBE_MISS_THRESHOLD - 1; i += 1) {
        await service.listDiscoverableNodes();
      }
      expect(await service.listDiscoverableNodes()).toEqual([]);
    });

    it('resets the miss counter when the candidate answers again', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.probeAddress('192.168.1.42');

      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
      await service.listDiscoverableNodes();
      await service.listDiscoverableNodes();

      // A laptop that was asleep for two refreshes must not cost the operator a retype.
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.listDiscoverableNodes();

      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
      await service.listDiscoverableNodes();
      expect(await service.listDiscoverableNodes()).toHaveLength(1);
    });

    it('drops a candidate the moment it becomes a paired peer', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.probeAddress('192.168.1.42');
      repo.listAll.mockResolvedValue([mockPeer()]);

      expect(await service.listDiscoverableNodes()).toEqual([]);
    });

    it('re-probes the address that answered rather than re-walking the port fallbacks', async () => {
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-hub.tailxyz.ts.net'));
      await service.probeAddress('192.168.1.42:5010');
      vi.mocked(global.fetch).mockClear();

      await service.listDiscoverableNodes();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe('http://192.168.1.42:5010/api/inference/pool/identify');
    });

    it('caps how many candidates it will remember', async () => {
      // Same reasoning as MAX_PENDING_INBOUND_REQUESTS: a map that only ever grows is a leak
      // whoever writes the next feature inherits.
      for (let i = 0; i < MAX_MANUAL_POOL_CANDIDATES + 5; i += 1) {
        vi.mocked(global.fetch).mockResolvedValue(identifyResponse(`peer-${i}.tailxyz.ts.net`));
        await service.probeAddress(`192.168.1.${i + 10}`);
      }

      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('peer-0.tailxyz.ts.net'));
      expect(await service.listDiscoverableNodes()).toHaveLength(MAX_MANUAL_POOL_CANDIDATES);
    });

    it('discovers peer Hubs from CI Portal dispatch API', async () => {
      portalClient.fetchDispatchDevices.mockResolvedValue([
        {
          id: 'portal-dev-1',
          name: 'cloud-hub',
          tailscaleDns: 'cloud-hub.tailxyz.ts.net',
        },
      ]);
      vi.mocked(global.fetch).mockResolvedValue(identifyResponse('cloud-hub.tailxyz.ts.net'));

      const candidates = await service.listDiscoverableNodes();

      expect(candidates).toContainEqual({
        tailscaleDeviceId: 'portal-dev-1',
        nodeFqdn: 'cloud-hub.tailxyz.ts.net',
        hostname: 'cloud-hub',
        source: 'portal',
      });
    });
  });
});
