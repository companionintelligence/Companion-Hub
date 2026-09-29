import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import type { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { mergePoolCandidates } from '../hub-pool-discovery.service';
import {
  CIHUB_SERVICE_TYPE,
  HubPoolMdnsService,
  MAX_DNS_POINTER_HOPS,
  MDNS_MAX_DISCOVERED_PEERS,
  MDNS_PEER_TTL_MS,
  buildMdnsAnnouncement,
  buildMdnsQuery,
  decodeDnsName,
  encodeDnsName,
  parseMdnsPacket,
} from '../hub-pool-mdns.service';
import type { DiscoverablePoolPeer } from '../hub-pool.types';

// ── Wire-format helpers for hand-built (and hostile) packets ──

function dnsHeader(counts: { qd?: number; an?: number }): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(counts.qd ?? 0, 4);
  header.writeUInt16BE(counts.an ?? 0, 6);
  return header;
}

const label = (text: string): Buffer => Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)]);
const pointer = (target: number): Buffer => Buffer.from([0xc0 | (target >> 8), target & 0xff]);
const ROOT = Buffer.from([0]);

function recordMeta(type: number, rdLength: number): Buffer {
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(1, 2);
  meta.writeUInt32BE(120, 4);
  meta.writeUInt16BE(rdLength, 8);
  return meta;
}

/**
 * Runs `fn` under a V8 watchdog. The failure these tests guard against is a parser stuck in a
 * synchronous loop, and such a loop never yields to the event loop — so neither vitest's own test
 * timeout nor a `Promise.race` against `setTimeout` could ever fire, and the run would simply hang.
 * `vm`'s timeout terminates the running script from a separate thread instead, which turns a hang
 * into an ordinary thrown error the test can report.
 */
function runWithWatchdog<T>(fn: () => T, timeoutMs = 1_000): T {
  return vm.runInNewContext('fn()', { fn }, { timeout: timeoutMs });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type PacketSink = { handleIncomingPacket: (buffer: Buffer, senderAddress: string) => void };
type PeerStore = { discovered: Map<string, unknown> };

function feed(service: HubPoolMdnsService, packet: Buffer, sender = '198.51.100.7'): void {
  (service as unknown as PacketSink).handleIncomingPacket(packet, sender);
}

function announcementFrom(ip: string, hostname = `peer-${ip.replaceAll('.', '-')}`): Buffer {
  return buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, hostname, 5002, ip, { isCiHub: 'true', poolProtocol: '2', hostname });
}

const peerIp = (i: number) => `10.9.${Math.floor(i / 256)}.${i % 256}`;

/**
 * Stand-in for the dgram socket, so the bind path can be driven without touching the host's real
 * port 5353 (which mDNSResponder or Avahi usually holds on a developer machine anyway).
 */
class FakeSocket extends EventEmitter {
  constructor(private readonly bindError?: NodeJS.ErrnoException) {
    super();
  }

  bind = vi.fn((_port: number, callback?: () => void) => {
    // dgram reports a failed bind asynchronously, on 'error', and never calls the bind callback.
    process.nextTick(() => {
      if (this.bindError) this.emit('error', this.bindError);
      else callback?.();
    });
    return this;
  });
  addMembership = vi.fn();
  dropMembership = vi.fn();
  setMulticastTTL = vi.fn();
  setMulticastLoopback = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('HubPoolMdnsService — DNS Packet Wire Format', () => {
  it('encodes and decodes DNS domain names with compression pointers', () => {
    const original = '_cihub._tcp.local';
    const encoded = encodeDnsName(original);
    const decoded = decodeDnsName(encoded, 0);

    expect(decoded.name).toBe(original);
    expect(decoded.nextOffset).toBe(encoded.length);
  });

  it('follows a chain of backward compression pointers and resumes after the first one', () => {
    // A: "_cihub._tcp.local" at 0, B: "box" -> A, C: "x" -> B
    const a = encodeDnsName('_cihub._tcp.local');
    const bStart = a.length;
    const b = Buffer.concat([label('box'), pointer(0)]);
    const cStart = bStart + b.length;
    const c = Buffer.concat([label('x'), pointer(bStart)]);
    const buffer = Buffer.concat([a, b, c, Buffer.from([0xaa, 0xbb])]);

    const decoded = decodeDnsName(buffer, cStart);
    expect(decoded.name).toBe('x.box._cihub._tcp.local');
    expect(decoded.nextOffset).toBe(cStart + c.length);
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

  it('parses a compressed announcement the way other mDNS responders send one', () => {
    // PTR "_cihub._tcp.local" -> "box" + ptr(12); SRV name = ptr(PTR rdata) -> port 5002, "box.local"
    const serviceName = encodeDnsName(CIHUB_SERVICE_TYPE);
    const ptrRdataStart = 12 + serviceName.length + 10;
    const ptrRdata = Buffer.concat([label('box'), pointer(12)]);
    const srvBody = Buffer.alloc(6);
    srvBody.writeUInt16BE(5002, 4);
    const srvRdata = Buffer.concat([srvBody, label('box'), label('local'), ROOT]);
    const packet = Buffer.concat([
      dnsHeader({ an: 2 }),
      serviceName,
      recordMeta(12, ptrRdata.length),
      ptrRdata,
      pointer(ptrRdataStart),
      recordMeta(33, srvRdata.length),
      srvRdata,
    ]);

    const parsed = parseMdnsPacket(packet);
    expect(parsed?.services).toEqual([CIHUB_SERVICE_TYPE]);
    expect(parsed?.port).toBe(5002);
    expect(parsed?.srvTarget).toBe('box.local');
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

describe('HubPoolMdnsService — hostile and malformed packets', () => {
  it('returns promptly from a 14-byte packet whose question name points at itself', () => {
    const packet = Buffer.concat([dnsHeader({ qd: 1 }), pointer(12)]);
    expect(packet).toHaveLength(14);

    const startedAt = performance.now();
    expect(runWithWatchdog(() => parseMdnsPacket(packet))).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('returns promptly from a packet whose answer name points at itself', () => {
    const packet = Buffer.concat([dnsHeader({ an: 1 }), pointer(12)]);
    expect(runWithWatchdog(() => parseMdnsPacket(packet))).toBeNull();
  });

  it('rejects a pointer back into its own name, which would loop through the label before it', () => {
    // offset 12: "a", offset 14: pointer to 12 — backward from the pointer, but not from the name
    const packet = Buffer.concat([dnsHeader({ qd: 1 }), label('a'), pointer(12), Buffer.alloc(4)]);
    expect(runWithWatchdog(() => parseMdnsPacket(packet))).toBeNull();
    expect(() => runWithWatchdog(() => decodeDnsName(packet, 12))).toThrow(/backward/);
  });

  it('rejects a forward compression pointer', () => {
    // The pointer at 0 targets a perfectly good name at 2 — it is refused only for pointing forward.
    const buffer = Buffer.concat([pointer(2), label('evil'), ROOT]);
    expect(() => decodeDnsName(buffer, 0)).toThrow(/backward/);

    // Two forward/backward pointers bouncing off each other are the two-packet version of the loop.
    const pingPong = Buffer.concat([dnsHeader({ qd: 1 }), pointer(14), pointer(12), Buffer.alloc(4)]);
    expect(runWithWatchdog(() => parseMdnsPacket(pingPong))).toBeNull();
  });

  it('caps the number of pointer hops even when every hop points backward', () => {
    // offset 0 is the root label; each following pointer targets the one before it.
    const chain = (hops: number): { buffer: Buffer; last: number } => {
      const parts: Buffer[] = [ROOT];
      let previous = 0;
      for (let i = 0; i < hops; i++) {
        parts.push(pointer(previous));
        previous = 1 + i * 2;
      }
      return { buffer: Buffer.concat(parts), last: previous };
    };

    const allowed = chain(MAX_DNS_POINTER_HOPS);
    expect(decodeDnsName(allowed.buffer, allowed.last).name).toBe('');

    const tooLong = chain(MAX_DNS_POINTER_HOPS + 1);
    expect(() => decodeDnsName(tooLong.buffer, tooLong.last)).toThrow(/hops/);
  });

  /**
   * Record 1 owns `ownerName` at offset 12 (opaque type, no rdata); every later record is a PTR whose
   * owner and rdata are both a pointer back to it, so each one costs two pointer hops.
   */
  function pointerHeavyPacket(ownerName: Buffer, ptrRecords: number): Buffer {
    const parts: Buffer[] = [dnsHeader({ an: 1 + ptrRecords }), ownerName, recordMeta(99, 0)];
    for (let i = 0; i < ptrRecords; i++) parts.push(pointer(12), recordMeta(12, 2), pointer(12));
    return Buffer.concat(parts);
  }

  it('shares one pointer budget across every name in a packet', () => {
    const owner = encodeDnsName(`box.${CIHUB_SERVICE_TYPE}`);
    const withinBudget = parseMdnsPacket(pointerHeavyPacket(owner, MAX_DNS_POINTER_HOPS / 2));
    expect(withinBudget?.services).toHaveLength(MAX_DNS_POINTER_HOPS / 2);
    expect(withinBudget?.srvTarget).toBe(`box.${CIHUB_SERVICE_TYPE}`);

    expect(parseMdnsPacket(pointerHeavyPacket(owner, MAX_DNS_POINTER_HOPS / 2 + 1))).toBeNull();
  });

  it('rejects a 64 KB datagram that expands one 255-octet name through thousands of pointers', () => {
    // 127 one-octet labels: the most labels a legal name can hold. With only a per-name cap each
    // two-byte pointer re-walked all of them, and this packet took ~144 ms to parse.
    const longest = Buffer.concat([...Array.from({ length: 127 }, () => label('a')), ROOT]);
    expect(longest).toHaveLength(255);
    const packet = pointerHeavyPacket(longest, Math.floor((65_507 - 12 - 255 - 10) / 14));
    expect(packet.length).toBeLessThanOrEqual(65_507);

    expect(runWithWatchdog(() => parseMdnsPacket(packet))).toBeNull();
  });

  it('rejects a name longer than 255 octets and accepts one of exactly 255', () => {
    const l63 = 'a'.repeat(63);
    // 3 x (1 + 63) + (1 + 61) + root = 255
    const longest = encodeDnsName(`${l63}.${l63}.${l63}.${'b'.repeat(61)}`);
    expect(longest).toHaveLength(255);
    expect(decodeDnsName(longest, 0).nextOffset).toBe(255);

    // 4 x (1 + 63) + root = 257
    const overLong = encodeDnsName(`${l63}.${l63}.${l63}.${l63}`);
    expect(() => decodeDnsName(overLong, 0)).toThrow(/255/);
    expect(parseMdnsPacket(Buffer.concat([dnsHeader({ qd: 1 }), overLong, Buffer.alloc(4)]))).toBeNull();
  });

  it('counts the length of labels reached through pointers toward the 255-octet limit', () => {
    // Each name is one 63-octet label plus a pointer to the previous name, so no single run of
    // labels is long, but the fourth name expands to 4 x 64 + 1 = 257 octets.
    const l63 = (ch: string) => label(ch.repeat(63));
    const first = Buffer.concat([l63('a'), ROOT]);
    const second = Buffer.concat([l63('b'), pointer(0)]);
    const third = Buffer.concat([l63('c'), pointer(first.length)]);
    const fourthStart = first.length + second.length + third.length;
    const fourth = Buffer.concat([l63('d'), pointer(first.length + second.length)]);
    const buffer = Buffer.concat([first, second, third, fourth]);

    expect(decodeDnsName(buffer, first.length + second.length).name).toHaveLength(63 * 3 + 2);
    expect(() => decodeDnsName(buffer, fourthStart)).toThrow(/255/);
  });

  it('rejects truncated names and truncated packets', () => {
    expect(() => decodeDnsName(Buffer.concat([label('abc')]), 0)).toThrow(/end of the packet/);
    expect(() => decodeDnsName(Buffer.from([3, 0x61]), 0)).toThrow(/end of the packet/);
    expect(() => decodeDnsName(Buffer.from([0xc0]), 0)).toThrow(/end of the packet/);
    expect(() => decodeDnsName(Buffer.from([0x41, 0x61]), 0)).toThrow(/label type/);

    const announcement = announcementFrom('192.168.1.50');
    for (const cut of [1, 3, 11, 40]) {
      expect(parseMdnsPacket(announcement.subarray(0, announcement.length - cut))).toBeNull();
    }
    // A header that promises four answers and carries none
    expect(parseMdnsPacket(dnsHeader({ an: 4 }))).toBeNull();
  });

  it('rejects an rdata name that runs past its own RDLENGTH', () => {
    const serviceName = encodeDnsName(CIHUB_SERVICE_TYPE);
    const ptrRdata = encodeDnsName(`box.${CIHUB_SERVICE_TYPE}`);
    const packet = Buffer.concat([dnsHeader({ an: 1 }), serviceName, recordMeta(12, 2), ptrRdata]);
    expect(parseMdnsPacket(packet)).toBeNull();
  });
});

describe('HubPoolMdnsService — Discovery Candidates', () => {
  it('filters out self and returns discoverable candidates with source=mdns and address', async () => {
    const logger = mock<LoggerService>();
    const tailscale = mock<TailscaleService>();

    tailscale.getStatusCached.mockResolvedValue({
      nodeFqdn: 'my-hub.tailxyz.ts.net',
      tailscaleIps: ['100.64.0.1'],
    } as never);

    const service = new HubPoolMdnsService(logger, tailscale);

    // Inject discovered peers directly into internal cache
    const testPacket = buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'peer-box', 5002, '192.168.1.42', {
      isCiHub: 'true',
      poolProtocol: '2',
      hostname: 'peer-box',
      nodeFqdn: 'peer-box.tailxyz.ts.net',
    });

    // Simulate incoming packet
    feed(service, testPacket, '192.168.1.42');

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

describe('HubPoolMdnsService — discovered peer cache bounds', () => {
  const T0 = Date.parse('2026-09-29T12:00:00Z');

  function newService(): HubPoolMdnsService {
    return new HubPoolMdnsService(mock<LoggerService>(), mock<TailscaleService>());
  }

  it('never holds more than MDNS_MAX_DISCOVERED_PEERS entries, evicting the least recently seen', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = newService();
    const total = MDNS_MAX_DISCOVERED_PEERS + 36;

    for (let i = 0; i < total; i++) {
      vi.setSystemTime(T0 + i);
      feed(service, announcementFrom(peerIp(i)));
    }

    expect((service as unknown as PeerStore).discovered.size).toBe(MDNS_MAX_DISCOVERED_PEERS);
    const ips = new Set(service.listDiscoveredPeers(T0 + total).map((peer) => peer.ip));
    // Exactly the newest MDNS_MAX_DISCOVERED_PEERS survive.
    expect(ips.has(peerIp(0))).toBe(false);
    expect(ips.has(peerIp(total - MDNS_MAX_DISCOVERED_PEERS - 1))).toBe(false);
    expect(ips.has(peerIp(total - MDNS_MAX_DISCOVERED_PEERS))).toBe(true);
    expect(ips.has(peerIp(total - 1))).toBe(true);
  });

  it('keeps a peer that re-announces and evicts the stalest one instead', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = newService();

    for (let i = 0; i < MDNS_MAX_DISCOVERED_PEERS; i++) {
      vi.setSystemTime(T0 + i);
      feed(service, announcementFrom(peerIp(i)));
    }
    vi.setSystemTime(T0 + 1_000);
    feed(service, announcementFrom(peerIp(0))); // peer 0 is now the freshest
    vi.setSystemTime(T0 + 1_001);
    feed(service, announcementFrom('10.99.0.1'));

    const ips = new Set(service.listDiscoveredPeers(T0 + 1_002).map((peer) => peer.ip));
    expect(ips.size).toBe(MDNS_MAX_DISCOVERED_PEERS);
    expect(ips.has(peerIp(0))).toBe(true);
    expect(ips.has(peerIp(1))).toBe(false);
    expect(ips.has('10.99.0.1')).toBe(true);
  });

  it('drops expired peers before evicting fresh ones, and still expires peers by TTL', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = newService();

    vi.setSystemTime(T0);
    for (let i = 0; i < MDNS_MAX_DISCOVERED_PEERS; i++) feed(service, announcementFrom(peerIp(i)));

    vi.setSystemTime(T0 + MDNS_PEER_TTL_MS + 1);
    feed(service, announcementFrom('10.99.0.2'));
    expect((service as unknown as PeerStore).discovered.size).toBe(1);

    expect(service.listDiscoveredPeers(T0 + 2 * MDNS_PEER_TTL_MS + 2)).toEqual([]);
  });

  it('drops a hostile datagram in the packet handler without recording or throwing', () => {
    const service = newService();
    const selfPointer = Buffer.concat([dnsHeader({ an: 1 }), pointer(12)]);

    expect(() => runWithWatchdog(() => feed(service, selfPointer))).not.toThrow();
    expect(service.listDiscoveredPeers()).toEqual([]);
  });
});

describe('HubPoolMdnsService — socket lifecycle', () => {
  it('does not hang module init when port 5353 cannot be bound, and runs without mDNS', async () => {
    vi.stubEnv('HUB_POOL_ENABLE_MDNS_TEST', '1');
    const bindError = Object.assign(new Error('bind EADDRINUSE 0.0.0.0:5353'), { code: 'EADDRINUSE' });
    const socket = new FakeSocket(bindError);
    vi.spyOn(dgram, 'createSocket').mockReturnValue(socket as unknown as dgram.Socket);
    const logger = mock<LoggerService>();
    const service = new HubPoolMdnsService(logger, mock<TailscaleService>());

    await withTimeout(service.onModuleInit(), 1_000, 'onModuleInit');

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));
    expect(socket.close).toHaveBeenCalled();
    await service.scan();
    await service.announce();
    expect(socket.send).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('keeps serving datagrams after a hostile one arrives on the bound socket', async () => {
    const socket = new FakeSocket();
    vi.spyOn(dgram, 'createSocket').mockReturnValue(socket as unknown as dgram.Socket);
    const service = new HubPoolMdnsService(mock<LoggerService>(), mock<TailscaleService>());

    await withTimeout(service.start(), 1_000, 'start');
    try {
      const rinfo = { address: '172.18.0.9', family: 'IPv4', port: 5353, size: 14 };
      const selfPointer = Buffer.concat([dnsHeader({ an: 1 }), pointer(12)]);
      runWithWatchdog(() => socket.emit('message', selfPointer, rinfo));
      socket.emit('message', announcementFrom('192.168.1.77', 'late-peer'), rinfo);

      expect(service.listDiscoveredPeers().map((peer) => peer.hostname)).toEqual(['late-peer']);
    } finally {
      await service.stop();
    }
  });
});
