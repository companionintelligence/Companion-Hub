import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import type { TailscaleService } from '@/modules/tailscale/tailscale.service';
import {
  HubPoolMdnsService,
  buildMdnsAnnouncement,
  buildMdnsQuery,
  decodeDnsName,
  encodeDnsName,
  parseMdnsPacket,
  CIHUB_SERVICE_TYPE,
} from '../hub-pool-mdns.service';
import { mergePoolCandidates } from '../hub-pool-discovery.service';
import type { DiscoverablePoolPeer } from '../hub-pool.types';

describe('HubPoolMdnsService — DNS Packet Wire Format', () => {
  it('encodes and decodes DNS domain names with compression pointers', () => {
    const original = '_cihub._tcp.local';
    const encoded = encodeDnsName(original);
    const decoded = decodeDnsName(encoded, 0);

    expect(decoded.name).toBe(original);
    expect(decoded.nextOffset).toBe(encoded.length);
  });

  it('builds and parses mDNS service announcements correctly', () => {
    const serviceType = CIHUB_SERVICE_TYPE;
    const hostname = 'studio-m4';
    const port = 5002;
    const ip = '192.168.1.120';
    const txtRecord = {
      isCiHub: 'true',
      poolProtocol: '2',
      hostname: 'studio-m4',
      nodeFqdn: 'studio-m4.tailxyz.ts.net',
    };

    const packet = buildMdnsAnnouncement(serviceType, hostname, port, ip, txtRecord);
    expect(packet.length).toBeGreaterThan(12);

    const parsed = parseMdnsPacket(packet);
    expect(parsed).not.toBeNull();
    expect(parsed?.services).toContain(serviceType);
    expect(parsed?.port).toBe(port);
    expect(parsed?.ip).toBe(ip);
    expect(parsed?.txt.isCiHub).toBe('true');
    expect(parsed?.txt.poolProtocol).toBe('2');
    expect(parsed?.txt.nodeFqdn).toBe('studio-m4.tailxyz.ts.net');
  });

  it('builds standard mDNS PTR query for _cihub._tcp.local', () => {
    const query = buildMdnsQuery(CIHUB_SERVICE_TYPE);
    expect(query.length).toBeGreaterThan(12);
    // Header QDCOUNT = 1
    expect(query.readUInt16BE(4)).toBe(1);
    // Header ANCOUNT = 0
    expect(query.readUInt16BE(6)).toBe(0);
  });
});

describe('HubPoolMdnsService — Discovery Candidates', () => {
  it('filters out self and returns discoverable candidates with source=mdns and address', async () => {
    const logger = mock<LoggerService>();
    const config = mock<ConfigurationService>();
    const tailscale = mock<TailscaleService>();

    tailscale.getStatusCached.mockResolvedValue({
      nodeFqdn: 'my-hub.tailxyz.ts.net',
      tailscaleIps: ['100.64.0.1'],
    } as never);

    const service = new HubPoolMdnsService(logger, config, tailscale);

    // Inject discovered peers directly into internal cache
    const testPacket = buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'peer-box', 5002, '192.168.1.42', {
      isCiHub: 'true',
      poolProtocol: '2',
      hostname: 'peer-box',
      nodeFqdn: 'peer-box.tailxyz.ts.net',
    });

    // Simulate incoming packet
    (service as unknown as { handleIncomingPacket: (b: Buffer, ip: string) => void }).handleIncomingPacket(testPacket, '192.168.1.42');

    const known = new Set<string>();
    const candidates = await service.getDiscoverableCandidates(known);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      tailscaleDeviceId: '',
      nodeFqdn: 'peer-box.tailxyz.ts.net',
      hostname: 'peer-box',
      source: 'mdns',
      address: '192.168.1.42:5002',
    });
  });

  it('merges mDNS candidates with Tailscale and Portal candidates without losing address', () => {
    const tailscaleEntry: DiscoverablePoolPeer = {
      tailscaleDeviceId: 'ts-dev-1',
      nodeFqdn: 'peer-box.tailxyz.ts.net',
      hostname: 'peer-box',
    };

    const mdnsEntry: DiscoverablePoolPeer = {
      tailscaleDeviceId: '',
      nodeFqdn: 'peer-box.tailxyz.ts.net',
      hostname: 'peer-box',
      source: 'mdns',
      address: '192.168.1.42:5002',
    };

    const lanOnlyEntry: DiscoverablePoolPeer = {
      tailscaleDeviceId: '',
      nodeFqdn: 'isolated-node.local',
      hostname: 'isolated-node',
      source: 'mdns',
      address: '192.168.1.43:5002',
    };

    const merged = mergePoolCandidates([tailscaleEntry], [mdnsEntry, lanOnlyEntry]);

    expect(merged).toHaveLength(2);

    // Tailscale entry won on identity, but was enriched with LAN address from mDNS
    const enrichedTailscale = merged.find((c) => c.nodeFqdn === 'peer-box.tailxyz.ts.net');
    expect(enrichedTailscale?.tailscaleDeviceId).toBe('ts-dev-1');
    expect(enrichedTailscale?.address).toBe('192.168.1.42:5002');
    expect(enrichedTailscale?.source).toBeUndefined(); // Tailnet keeps absent source

    // LAN-only entry kept its mdns source and direct address
    const lanCandidate = merged.find((c) => c.nodeFqdn === 'isolated-node.local');
    expect(lanCandidate?.source).toBe('mdns');
    expect(lanCandidate?.address).toBe('192.168.1.43:5002');
  });
});
