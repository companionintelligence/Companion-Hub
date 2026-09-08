import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { LoggerService } from '@/core/logger/logger.service';
import { TailscaleService, type TailscaleStatus } from '@/modules/tailscale/tailscale.service';
import { TailscaleAdminApiService } from '@/modules/tailscale/tailscale-admin-api.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { PortalClientService } from '@/core/portal/portal-client.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolIdentityService } from '../hub-pool-identity.service';
import { HubPoolPairingPinService } from '../hub-pool-pairing-pin.service';
import { HubPoolLoadService } from '../hub-pool-load.service';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { HubPoolPinService } from '../hub-pool-pin.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolController } from '../hub-pool.controller';
import { HubPoolDiscoveryService, mergePoolCandidates } from '../hub-pool-discovery.service';
import type { DiscoverablePoolPeer } from '../hub-pool.types';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

/**
 * The `/identify` body a real CI-Hub answers with — produced by the REAL controller, not written out
 * here by hand.
 *
 * This is the whole point of the helper. The previous version of this file hard-coded
 * `{ isCiHub: true, nodeFqdn }`, and kept passing for a build in which the controller had stopped
 * returning `nodeFqdn` at all: the producer was pinned in `hub-pool.controller.test.ts`, the consumer
 * was pinned here, and nothing compared the two. `POST peers/probe` was dead in that build and no
 * test noticed. Running the controller and serializing its output the way the wire would is what
 * makes this class of drift a failure rather than a silence.
 */
async function realIdentifyBody(): Promise<unknown> {
  const controller = new HubPoolController(
    mock<HubPoolPeerService>(),
    mock<PoolProxyService>(),
    mock<TailscaleService>(),
    mock<ConfigurationService>(),
    new HubPoolRoutingLogService(),
    mock<HubPoolDiscoveryService>(),
    mock<HubPoolPinService>(),
  );
  // JSON round-trip: a field the controller returns as `undefined` does not survive the wire, and a
  // consumer test that skips this step is testing an object the peer never sends.
  return JSON.parse(JSON.stringify(await controller.identify()));
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

/** Only the column the candidate paths read. Spelling the whole row out here just invites drift with the schema. */
function pairedPeer(nodeFqdn: string): HubPoolPeer {
  return { nodeFqdn } as unknown as HubPoolPeer;
}

/** One other node in the local Tailscale daemon's peer map — the zero-config half of the tailnet source. */
const tailnetPeer = { id: 'ts-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', hostname: 'peer-hub', ip: '100.64.0.2', online: true };

/** A tailnet-connected Hub with a name — the state most of this file runs in. */
function selfStatus(overrides: Partial<TailscaleStatus> = {}): TailscaleStatus {
  return {
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
    ...overrides,
  };
}

/**
 * The REAL `HubPoolPeerService` behind the discovery service, for the tests that make a claim about
 * how much I/O discovery costs.
 *
 * A `MockProxy<HubPoolPeerService>` cannot answer that question: `listDiscoverableDevices` is where
 * the decision to probe or not to probe actually lives, so a test that stubs it out and then asserts
 * on `global.fetch` is asserting about its own stub. That is the same producer/consumer drift
 * {@link realIdentifyBody} exists to stop, one layer down — and it bit for real, when a doc comment
 * promising "no credential means zero network calls" (true when the bail was
 * `!tailscaleAdminApi.isConfigured()`) survived a merge that changed the bail to
 * `!selfStatus.connected && !tailscaleAdminApi.isConfigured()`.
 *
 * Only three of these dependencies are read on this path — the Tailscale status, whether an Admin API
 * credential exists, and the peer table. The rest are mocks because this file is not testing them.
 */
function realPeerService(options: { status: TailscaleStatus; adminApiConfigured: boolean }): HubPoolPeerService {
  const repo = mock<HubPoolPeerRepository>();
  repo.listAll.mockResolvedValue([]);

  const tailscale = mock<TailscaleService>();
  tailscale.getStatusCached.mockResolvedValue(options.status);

  const adminApi = mock<TailscaleAdminApiService>();
  adminApi.isConfigured.mockReturnValue(options.adminApiConfigured);
  adminApi.listDevices.mockResolvedValue([]);

  return new HubPoolPeerService(
    mock<LoggerService>(),
    repo,
    tailscale,
    adminApi,
    mock<EncryptionService>(),
    mock<InferenceRouterService>(),
    mock<HubPoolLoadService>(),
    mock<ConfigurationService>(),
    mock<HubPoolIdentityService>(),
    mock<HubPoolPairingPinService>(),
    mock<HubPoolPressureService>(),
  );
}

describe('mergePoolCandidates', () => {
  // Shaped exactly as `listDiscoverableDevices` emits one: no `source`, because absence is how a
  // tailnet entry says it came from the tailnet. Tagging it here would test a shape no producer
  // builds, and would have hidden that `'tailscale'` was a union member nothing could emit.
  const tailscaleEntry: DiscoverablePoolPeer = {
    tailscaleDeviceId: 'ts-1',
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    hostname: 'peer-hub',
  };
  const portalEntry: DiscoverablePoolPeer = {
    tailscaleDeviceId: '',
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    hostname: 'peer-hub',
    source: 'portal',
  };

  it('offers a node reachable both ways exactly once', () => {
    const merged = mergePoolCandidates([tailscaleEntry], [portalEntry]);
    expect(merged).toEqual([tailscaleEntry]);
  });

  it('keeps the Tailscale entry on a merge, because its name is what the transport dials', () => {
    const merged = mergePoolCandidates([tailscaleEntry], [portalEntry]);
    // The two entries differ only in `source`, so this is the whole discrimination: undefined is
    // the tailnet entry, `'portal'` is the one that lost.
    expect(merged[0]?.source).toBeUndefined();
  });

  it('merges on the normalized FQDN, so a trailing dot or different case is the same node', () => {
    const trailingDot: DiscoverablePoolPeer = { ...portalEntry, nodeFqdn: 'peer-hub.tailxyz.ts.net.' };
    const upperCase: DiscoverablePoolPeer = { ...portalEntry, nodeFqdn: 'PEER-HUB.tailxyz.ts.net' };

    expect(mergePoolCandidates([tailscaleEntry], [trailingDot])).toEqual([tailscaleEntry]);
    expect(mergePoolCandidates([tailscaleEntry], [upperCase])).toEqual([tailscaleEntry]);
  });

  it('never merges two genuinely different nodes', () => {
    const other: DiscoverablePoolPeer = { ...portalEntry, nodeFqdn: 'different-hub.tailxyz.ts.net', hostname: 'different-hub' };
    expect(mergePoolCandidates([tailscaleEntry], [other])).toHaveLength(2);
  });

  it('does NOT key on a UUID the candidate claims about itself', () => {
    // `/identify` is unauthenticated, so anything reachable on the network can claim any UUID. If
    // the merge keyed on one, a hostile box could claim a real node's UUID and suppress that node
    // from the operator's candidate list — or graft itself onto the entry the operator then pairs
    // with. Only the FQDN, which the tailnet control plane also attests, is a merge key. Nothing
    // populates `claimedNodeUuid` in this build; this test is what keeps that true of the next
    // source added here as well.
    const impostor: DiscoverablePoolPeer = {
      tailscaleDeviceId: '',
      nodeFqdn: 'attacker-box.tailxyz.ts.net',
      hostname: 'attacker-box',
      source: 'portal',
      claimedNodeUuid: 'a-uuid-copied-from-the-real-peer',
    };
    const real: DiscoverablePoolPeer = { ...tailscaleEntry, claimedNodeUuid: 'a-uuid-copied-from-the-real-peer' };

    const merged = mergePoolCandidates([real], [impostor]);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.nodeFqdn)).toContain('peer-hub.tailxyz.ts.net');
  });

  it('back-fills a Tailscale device id onto an entry that lacks one when it turns up', () => {
    const merged = mergePoolCandidates([], [portalEntry, { ...portalEntry, tailscaleDeviceId: 'ts-1' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.tailscaleDeviceId).toBe('ts-1');
  });

  it('is a no-op on the Tailscale-only list every single-node Hub sees', () => {
    expect(mergePoolCandidates([tailscaleEntry], [])).toEqual([tailscaleEntry]);
    expect(mergePoolCandidates([], [])).toEqual([]);
  });
});

describe('HubPoolDiscoveryService', () => {
  let peerService: MockProxy<HubPoolPeerService>;
  let tailscaleService: MockProxy<TailscaleService>;
  let portalClient: MockProxy<PortalClientService>;
  let service: HubPoolDiscoveryService;

  beforeEach(() => {
    peerService = mock<HubPoolPeerService>();
    tailscaleService = mock<TailscaleService>();
    portalClient = mock<PortalClientService>();
    lookup.mockReset();

    peerService.listDiscoverableDevices.mockResolvedValue([]);
    peerService.listPeers.mockResolvedValue([]);
    tailscaleService.getStatusCached.mockResolvedValue(selfStatus());
    portalClient.fetchDispatchDevices.mockResolvedValue([]);

    service = new HubPoolDiscoveryService(mock<LoggerService>(), peerService, tailscaleService, portalClient);
    global.fetch = vi.fn();
  });

  describe('probeAddress', () => {
    it('accepts what a real Hub actually answers with, controller output straight into the prober', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));

      const result = await service.probeAddress('192.168.1.42');

      expect(result).toEqual({ address: '192.168.1.42', isCiHub: true, poolProtocol: 2, pairable: true, reason: null });
    });

    it('does not require a name, because `/identify` no longer discloses one', async () => {
      // The regression this file exists to prevent: the prober must key off the protocol version,
      // never off a `nodeFqdn` the endpoint deliberately stopped returning.
      const body = (await realIdentifyBody()) as Record<string, unknown>;

      expect(body).not.toHaveProperty('nodeFqdn');
      expect(body).not.toHaveProperty('nodeUuid');
      expect(body).not.toHaveProperty('publicKey');
    });

    it('walks the port fallbacks, because the container API_PORT is not the published one', async () => {
      const body = await realIdentifyBody();
      vi.mocked(global.fetch)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(jsonResponse(body));

      const result = await service.probeAddress('192.168.1.42');

      expect(result.pairable).toBe(true);
      expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe('http://192.168.1.42:5002/api/inference/pool/identify');
      expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toBe('https://192.168.1.42:5002/api/inference/pool/identify');
      expect(vi.mocked(global.fetch).mock.calls[2]?.[0]).toBe('http://192.168.1.42:3000/api/inference/pool/identify');
    });

    it('uses only the port the operator typed, when they typed one', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));

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
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));

      await expect(service.probeAddress('mini-pc.lan')).resolves.toMatchObject({ pairable: true });
    });

    it('rejects an unparseable address with a message naming the shapes that work', async () => {
      await expect(service.probeAddress('http://192.168.1.42/admin')).rejects.toThrow(/192\.168\.1\.42/);
    });

    it('reports an address that answers nothing as unreachable, not as an error', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.probeAddress('192.168.1.99');

      expect(result).toMatchObject({ isCiHub: false, poolProtocol: null, pairable: false, reason: 'unreachable' });
    });

    it('reports something that is not a Hub distinctly from something unreachable', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ hello: 'world' }));

      const result = await service.probeAddress('192.168.1.50');

      expect(result).toMatchObject({ isCiHub: false, reason: 'not_a_hub' });
    });

    it('reports a protocol-1 Hub as found but not pairable by address', async () => {
      // It ignores the PIN and answers `{ received: true }`, so it can never tell this node its
      // tailnet name — and without a name there is nothing to key a peer row on. Saying so here
      // beats letting the operator find out from a failed pairing.
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ isCiHub: true }));

      const result = await service.probeAddress('192.168.1.42');

      expect(result).toMatchObject({ isCiHub: true, poolProtocol: null, pairable: false, reason: 'protocol_too_old' });
    });
  });

  describe('pairAtAddress', () => {
    it('hands the peer service the origin that answered, and the operator’s PIN', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));
      peerService.initiatePairingAtAddress.mockResolvedValue({ id: 'peer-1' } as never);

      await service.pairAtAddress('192.168.1.42:5010', 'LAN box', '123456');

      expect(peerService.initiatePairingAtAddress).toHaveBeenCalledWith('http://192.168.1.42:5010', 'LAN box', '123456');
    });

    it('re-checks the address is private before the request that carries a pairing token', async () => {
      await expect(service.pairAtAddress('93.184.216.34', undefined, '123456')).rejects.toThrow(BadRequestException);
      expect(peerService.initiatePairingAtAddress).not.toHaveBeenCalled();
    });

    it('refuses to hand a token to something that never answered', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.pairAtAddress('192.168.1.99', undefined, '123456')).rejects.toThrow(/Nothing answered/);
      expect(peerService.initiatePairingAtAddress).not.toHaveBeenCalled();
    });

    it('refuses to hand a token to something that is not a CI-Hub', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ hello: 'world' }));

      await expect(service.pairAtAddress('192.168.1.50', undefined, '123456')).rejects.toThrow(/not a CI-Hub/);
      expect(peerService.initiatePairingAtAddress).not.toHaveBeenCalled();
    });
  });

  describe('listDiscoverableNodes', () => {
    it('offers named tailnet candidates, untagged, because absent source means the tailnet', async () => {
      // Entries here are consumed by handing `nodeFqdn` to `peers/pair`. The frontend and CLI copies
      // of this shape carry no `source` field at all, so a tailnet entry must serialize exactly as
      // they declare it.
      peerService.listDiscoverableDevices.mockResolvedValue([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'remote-hub.tailxyz.ts.net', hostname: 'remote-hub' },
      ]);

      expect(await service.listDiscoverableNodes()).toEqual([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'remote-hub.tailxyz.ts.net', hostname: 'remote-hub' },
      ]);
    });

    it('costs nothing only when the tailnet is down, no Admin API credential exists, and no Portal client is wired', async () => {
      // Driven through the REAL peer service, because the bail this pins is inside
      // `listDiscoverableDevices`. All three conditions have to hold at once: see the sibling test
      // below for what a merely-credential-less Hub actually pays.
      const offline = new HubPoolDiscoveryService(
        mock<LoggerService>(),
        realPeerService({ status: selfStatus({ connected: false, peers: [tailnetPeer] }), adminApiConfigured: false }),
        tailscaleService,
      );

      expect(await offline.listDiscoverableNodes()).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('probes every unpaired tailnet peer when the daemon is connected, even with no Admin API credential', async () => {
      // The cost the doc comment on `listDiscoverableNodes` promises, and the reason `getPoolStatus`
      // must never call it. Before the #1274/#1277 merge the bail was `!isConfigured()` and this was
      // genuinely zero; it is not zero any more, and that has to fail loudly if it silently changes
      // back or grows.
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));
      const connected = new HubPoolDiscoveryService(
        mock<LoggerService>(),
        realPeerService({ status: selfStatus({ peers: [tailnetPeer] }), adminApiConfigured: false }),
        tailscaleService,
      );

      const candidates = await connected.listDiscoverableNodes();

      expect(vi.mocked(global.fetch).mock.calls.map((call) => call[0])).toEqual(['https://peer-hub.tailxyz.ts.net/api/inference/pool/identify']);
      expect(candidates).toEqual([{ tailscaleDeviceId: 'ts-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', hostname: 'peer-hub' }]);
    });

    it('never remembers a probed address as a candidate', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));
      await service.probeAddress('192.168.1.42');

      // An unnamed candidate would be a second identity space beside `node_fqdn`, keyed on something
      // an unauthenticated responder chose. The probe is a diagnostic; pairing is the durable act.
      expect(await service.listDiscoverableNodes()).toEqual([]);
    });

    it('discovers peer Hubs from CI Portal dispatch API', async () => {
      portalClient.fetchDispatchDevices.mockResolvedValue([
        {
          id: 'portal-dev-1',
          name: 'cloud-hub',
          tailscaleDns: 'cloud-hub.tailxyz.ts.net',
        },
      ]);
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));

      const candidates = await service.listDiscoverableNodes();

      expect(candidates).toContainEqual({
        tailscaleDeviceId: 'portal-dev-1',
        nodeFqdn: 'cloud-hub.tailxyz.ts.net',
        hostname: 'cloud-hub',
        source: 'portal',
      });
      expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe('https://cloud-hub.tailxyz.ts.net/api/inference/pool/identify');
    });

    it('offers a node both directories know exactly once, keeping the tailnet entry', async () => {
      peerService.listDiscoverableDevices.mockResolvedValue([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', hostname: 'peer-hub' },
      ]);
      portalClient.fetchDispatchDevices.mockResolvedValue([{ id: 'portal-dev-1', name: 'peer-hub', tailscaleDns: 'peer-hub.tailxyz.ts.net' }]);
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));

      const candidates = await service.listDiscoverableNodes();

      expect(candidates).toEqual([{ tailscaleDeviceId: 'ts-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', hostname: 'peer-hub' }]);
    });

    it('will not offer a Portal device Portal knows only by LAN address', async () => {
      // The row would be consumed by handing `nodeFqdn` to `peers/pair`, and `normalizePeerFqdn`
      // refuses an IP literal — so an address here is an entry that can only ever fail. Such a Hub
      // is paired with by address and PIN, which is the route that does learn a name.
      portalClient.fetchDispatchDevices.mockResolvedValue([{ id: 'portal-dev-2', name: 'lan-hub', lanIp: '192.168.1.42' }]);

      expect(await service.listDiscoverableNodes()).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('skips a Portal device that is this node, or already a peer, before probing it', async () => {
      peerService.listPeers.mockResolvedValue([pairedPeer('peer-hub.tailxyz.ts.net')]);
      portalClient.fetchDispatchDevices.mockResolvedValue([
        { id: 'portal-self', name: 'self-hub', tailscaleDns: 'self-hub.tailxyz.ts.net' },
        { id: 'portal-dev-1', name: 'peer-hub', tailscaleDns: 'PEER-HUB.tailxyz.ts.net.' },
      ]);

      expect(await service.listDiscoverableNodes()).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('works with no Portal client wired in at all, which is every unregistered Hub', async () => {
      // Also the constructor shape `hub-pool-two-node.test.ts` builds. Portal discovery is one more
      // source, never a requirement.
      const withoutPortal = new HubPoolDiscoveryService(mock<LoggerService>(), peerService);

      expect(await withoutPortal.listDiscoverableNodes()).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
