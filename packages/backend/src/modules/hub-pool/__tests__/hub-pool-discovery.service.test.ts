import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolController } from '../hub-pool.controller';
import { HubPoolDiscoveryService } from '../hub-pool-discovery.service';

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
  );
  // JSON round-trip: a field the controller returns as `undefined` does not survive the wire, and a
  // consumer test that skips this step is testing an object the peer never sends.
  return JSON.parse(JSON.stringify(await controller.identify()));
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe('HubPoolDiscoveryService', () => {
  let peerService: MockProxy<HubPoolPeerService>;
  let service: HubPoolDiscoveryService;

  beforeEach(() => {
    peerService = mock<HubPoolPeerService>();
    lookup.mockReset();
    peerService.listDiscoverableDevices.mockResolvedValue([]);

    service = new HubPoolDiscoveryService(mock<LoggerService>(), peerService);
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
    it('offers named tailnet candidates and nothing else', async () => {
      // Entries here are consumed by handing `nodeFqdn` to `peers/pair`. An address has no name to
      // put there, so it is never a candidate — it is paired with directly.
      peerService.listDiscoverableDevices.mockResolvedValue([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'remote-hub.tailxyz.ts.net', hostname: 'remote-hub' },
      ]);

      expect(await service.listDiscoverableNodes()).toEqual([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'remote-hub.tailxyz.ts.net', hostname: 'remote-hub' },
      ]);
    });

    it('issues no network calls of its own, so a peerless Hub pays nothing for discovery', async () => {
      await service.listDiscoverableNodes();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('never remembers a probed address as a candidate', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(await realIdentifyBody()));
      await service.probeAddress('192.168.1.42');

      // An unnamed candidate would be a second identity space beside `node_fqdn`, keyed on something
      // an unauthenticated responder chose. The probe is a diagnostic; pairing is the durable act.
      expect(await service.listDiscoverableNodes()).toEqual([]);
    });
  });
});
