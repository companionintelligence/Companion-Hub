import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { mergePoolCandidates } from '../hub-pool-discovery.service';
import {
  CIHUB_COMPAT_SERVICE_TYPE,
  CIHUB_SERVICE_TYPE,
  HubPoolMdnsService,
  MAX_DNS_POINTER_HOPS,
  MDNS_MAX_DISCOVERED_PEERS,
  MDNS_MIN_MULTICAST_INTERVAL_MS,
  MDNS_PEER_TTL_MS,
  MDNS_PORT,
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

/** An announcement that really came from `ip` — the cache is keyed on the datagram's sender, not its A record. */
function hear(service: HubPoolMdnsService, ip: string, hostname?: string): void {
  feed(service, announcementFrom(ip, hostname), ip);
}

const peerIp = (i: number) => `10.9.${Math.floor(i / 256)}.${i % 256}`;

/** This Hub's own container address and host name, as the stubbed `os` reports them. */
const SELF_IP = '172.18.0.5';
const SELF_HOST = 'hub-self';

/** Pin the interfaces and host name, so what the Hub announces does not depend on the machine running the test. */
function stubHostNetwork(): void {
  // The SRV port comes from the first of these that is set, and a CI runner may set any of them.
  vi.stubEnv('API_PORT', '5002');
  vi.spyOn(os, 'hostname').mockReturnValue(SELF_HOST);
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    eth0: [{ address: SELF_IP, netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:ac:12:00:05', internal: false, cidr: `${SELF_IP}/16` }],
  });
}

/**
 * The REAL ConfigurationService, minus its constructor (which reads the data dir) and its disk write.
 * Real on purpose: the runtime toggle only works if a write through `setHubPoolPreferences` reaches
 * the mDNS service, and a hand-written stub of the listener would be testing itself.
 */
function poolSettings(userSettings: Record<string, unknown> = {}): ConfigurationService {
  const configuration = Object.create(ConfigurationService.prototype) as ConfigurationService;
  Object.assign(configuration, {
    config: { demoMode: false, userSettings: { ...userSettings } },
    mergeSettingsToDisk: vi.fn().mockResolvedValue(undefined),
    logger: mock<LoggerService>(),
  });
  return configuration;
}

/** Every socket `dgram.createSocket` hands out from here on, in order. */
function fakeSockets(): FakeSocket[] {
  const sockets: FakeSocket[] = [];
  vi.spyOn(dgram, 'createSocket').mockImplementation(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as dgram.Socket;
  });
  return sockets;
}

/** Services {@link enabledService} opened, closed after each test so no announce timer outlives it. */
const liveServices: HubPoolMdnsService[] = [];

/** A service with LAN discovery switched on and its (fake) socket open. */
async function enabledService(): Promise<{ service: HubPoolMdnsService; socket: FakeSocket; configuration: ConfigurationService }> {
  stubHostNetwork();
  const sockets = fakeSockets();
  const configuration = poolSettings({ hubPoolMdnsEnabled: true });
  const service = new HubPoolMdnsService(mock<LoggerService>(), configuration);
  liveServices.push(service);
  await withTimeout(service.reconcile(), 1_000, 'reconcile');
  const socket = sockets[0];
  if (!socket) throw new Error('reconcile did not open a socket');
  return { service, socket, configuration };
}

function sentPackets(socket: FakeSocket): Buffer[] {
  return socket.send.mock.calls.map((call) => call[0] as Buffer);
}

/** Type and class of every answer record, walked with the service's own decoder. */
function answerRecordClasses(packet: Buffer): Array<{ type: number; cls: number }> {
  let offset = 12;
  for (let i = 0; i < packet.readUInt16BE(4); i++) offset = decodeDnsName(packet, offset).nextOffset + 4;
  const records: Array<{ type: number; cls: number }> = [];
  for (let i = 0; i < packet.readUInt16BE(6); i++) {
    offset = decodeDnsName(packet, offset).nextOffset;
    records.push({ type: packet.readUInt16BE(offset), cls: packet.readUInt16BE(offset + 2) });
    offset += 10 + packet.readUInt16BE(offset + 8);
  }
  return records;
}

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

afterEach(async () => {
  await Promise.all(liveServices.splice(0).map((service) => service.onModuleDestroy()));
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

describe('HubPoolMdnsService — opt-in setting', () => {
  // Live on core-2 and beta-red (2026-09-29): the socket was bound 0.0.0.0:5353 inside the Hub
  // container with no setting and no link to poolEnabled, and on a bridge network it reached only
  // the Hub's own sibling containers. These pin that it now binds nothing unless asked to.

  it('binds nothing at boot when the setting is absent, which is the default', async () => {
    vi.stubEnv('HUB_POOL_ENABLE_MDNS_TEST', '1');
    const createSocket = vi.spyOn(dgram, 'createSocket');
    const service = new HubPoolMdnsService(mock<LoggerService>(), poolSettings());

    await withTimeout(service.onModuleInit(), 1_000, 'onModuleInit');

    expect(createSocket).not.toHaveBeenCalled();
    expect(service.isActive()).toBe(false);
    expect(service.getDiscoverableCandidates(new Set())).toEqual([]);
    await service.onModuleDestroy();
  });

  it('binds nothing while the pool is off, by setting or by .env, even with LAN discovery on', async () => {
    vi.stubEnv('HUB_POOL_ENABLE_MDNS_TEST', '1');
    const createSocket = vi.spyOn(dgram, 'createSocket');

    const poolOff = new HubPoolMdnsService(mock<LoggerService>(), poolSettings({ hubPoolMdnsEnabled: true, hubPoolEnabled: false }));
    await poolOff.onModuleInit();
    expect(poolOff.isEnabledBySettings()).toBe(false);

    vi.stubEnv('HUB_POOL_USER_DISABLED', 'true');
    const envOff = new HubPoolMdnsService(mock<LoggerService>(), poolSettings({ hubPoolMdnsEnabled: true }));
    await envOff.onModuleInit();
    expect(envOff.isEnabledBySettings()).toBe(false);

    expect(createSocket).not.toHaveBeenCalled();
    await poolOff.onModuleDestroy();
    await envOff.onModuleDestroy();
  });

  it('is off with no configuration to read at all', async () => {
    const createSocket = vi.spyOn(dgram, 'createSocket');
    const service = new HubPoolMdnsService(mock<LoggerService>());

    await service.reconcile();

    expect(createSocket).not.toHaveBeenCalled();
  });

  it('opens and closes the socket as either switch flips at runtime, with no restart', async () => {
    vi.stubEnv('HUB_POOL_ENABLE_MDNS_TEST', '1');
    stubHostNetwork();
    const sockets = fakeSockets();
    const configuration = poolSettings();
    const service = new HubPoolMdnsService(mock<LoggerService>(), configuration);
    await service.onModuleInit();
    expect(sockets).toHaveLength(0);

    // Only the real settings write the PATCH route uses, and never a call into the service: the
    // switch works only if that write reaches the socket on its own.
    await configuration.setHubPoolPreferences({ poolMdnsEnabled: true });
    await vi.waitFor(() => expect(sockets[0]?.addMembership).toHaveBeenCalled());
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.bind).toHaveBeenCalledWith(MDNS_PORT, expect.any(Function));
    expect(service.isActive()).toBe(true);

    await configuration.setHubPoolPreferences({ poolMdnsEnabled: false });
    await vi.waitFor(() => expect(sockets[0]?.close).toHaveBeenCalled());
    expect(sockets[0]?.dropMembership).toHaveBeenCalled();
    expect(service.isActive()).toBe(false);

    // Back on, then the POOL switched off underneath it: the socket follows the master switch too.
    await configuration.setHubPoolPreferences({ poolMdnsEnabled: true });
    await vi.waitFor(() => expect(sockets[1]?.addMembership).toHaveBeenCalled());
    await configuration.setHubPoolPreferences({ poolEnabled: false });
    await vi.waitFor(() => expect(sockets[1]?.close).toHaveBeenCalled());
    expect(service.isActive()).toBe(false);

    // A write that touches neither switch leaves the socket alone.
    await configuration.setHubPoolPreferences({ poolEnabled: true });
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    await configuration.setHubPoolPreferences({ poolLocalAffinity: 4 });
    await service.reconcile();
    expect(sockets).toHaveLength(3);
    expect(sockets[2]?.close).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('stops following the settings once the module is destroyed', async () => {
    vi.stubEnv('HUB_POOL_ENABLE_MDNS_TEST', '1');
    const sockets = fakeSockets();
    const configuration = poolSettings();
    const service = new HubPoolMdnsService(mock<LoggerService>(), configuration);
    await service.onModuleInit();
    await service.onModuleDestroy();

    await configuration.setHubPoolPreferences({ poolMdnsEnabled: true });
    // Give a listener that was left subscribed every chance to open a socket.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sockets).toHaveLength(0);
  });

  it('forgets every Hub it heard when switched off, so discovery returns no mDNS rows', async () => {
    const { service, configuration } = await enabledService();
    hear(service, '192.168.1.42', 'peer-box');
    expect(service.getDiscoverableCandidates(new Set())).toHaveLength(1);

    await configuration.setHubPoolPreferences({ poolMdnsEnabled: false });
    await service.reconcile();

    expect(service.getDiscoverableCandidates(new Set())).toEqual([]);
    expect(service.listDiscoveredPeers()).toEqual([]);
    // And a datagram handled after the close (an event already queued) records nothing.
    hear(service, '192.168.1.43', 'late-box');
    expect(service.listDiscoveredPeers()).toEqual([]);
  });
});

describe('HubPoolMdnsService — what the Hub announces', () => {
  it('announces without the MagicDNS name: the TXT record is txtvers, isCiHub and poolProtocol only', async () => {
    const { socket } = await enabledService();
    const packets = sentPackets(socket);
    // One per service type per LAN address; the stubbed host has one LAN address.
    expect(packets).toHaveLength(2);
    for (const packet of packets) {
      const parsed = parseMdnsPacket(packet);
      expect(Object.keys(parsed?.txt ?? {}).sort()).toEqual(['isCiHub', 'poolProtocol', 'txtvers']);
      expect(parsed?.txt.nodeFqdn).toBeUndefined();
      expect(parsed?.srvTarget).toBe(`${SELF_HOST}.local`);
    }
  });

  it('clears the cache-flush bit on the shared PTR record and keeps it on SRV, TXT and A', () => {
    // RFC 6762 §10.2 reserves the bit for unique records; on a PTR every other Hub's entry for the
    // same service type would be flushed from a listener's cache each time one Hub announced.
    const records = answerRecordClasses(buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'hub-a', 5002, '192.168.1.10', { txtvers: '1' }));

    expect(records).toEqual([
      { type: 12, cls: 0x0001 },
      { type: 33, cls: 0x8001 },
      { type: 16, cls: 0x8001 },
      { type: 1, cls: 0x8001 },
    ]);
  });
});

describe('HubPoolMdnsService — answering queries', () => {
  const T0 = Date.parse('2026-09-29T12:00:00Z');
  const querier = { address: '192.168.1.30', family: 'IPv4', port: MDNS_PORT, size: 0 };

  it('answers a PTR query for the desktop service type with the full record set', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { socket } = await enabledService();
    socket.send.mockClear();
    // Past the one-second floor the boot announcement started.
    vi.setSystemTime(T0 + MDNS_MIN_MULTICAST_INTERVAL_MS);
    socket.emit('message', buildMdnsQuery(CIHUB_COMPAT_SERVICE_TYPE), querier);

    const packets = sentPackets(socket);
    expect(packets).toHaveLength(1);
    expect(socket.send.mock.calls[0]?.slice(3)).toEqual([MDNS_PORT, '224.0.0.251']);
    const answer = parseMdnsPacket(packets[0] as Buffer);
    expect(answer?.isResponse).toBe(true);
    expect(answer?.services).toEqual([CIHUB_COMPAT_SERVICE_TYPE]);
    expect(answer?.srvTarget).toBe(`${SELF_HOST}.local`);
    expect(answer?.port).toBe(5002);
    expect(answer?.ip).toBe(SELF_IP);
    expect(answer?.txt.nodeFqdn).toBeUndefined();
  });

  it('answers at most once a second per service type, however many queries arrive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { socket } = await enabledService();
    socket.send.mockClear();
    vi.setSystemTime(T0 + MDNS_MIN_MULTICAST_INTERVAL_MS);
    for (let i = 0; i < 50; i++) socket.emit('message', buildMdnsQuery(CIHUB_SERVICE_TYPE), querier);
    expect(sentPackets(socket)).toHaveLength(1);

    vi.setSystemTime(T0 + 2 * MDNS_MIN_MULTICAST_INTERVAL_MS);
    socket.emit('message', buildMdnsQuery(CIHUB_SERVICE_TYPE), querier);
    expect(sentPackets(socket)).toHaveLength(2);
  });

  it('does not answer a query for any other service', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { socket } = await enabledService();
    socket.send.mockClear();
    vi.setSystemTime(T0 + 5 * MDNS_MIN_MULTICAST_INTERVAL_MS);
    socket.emit('message', buildMdnsQuery('_http._tcp.local'), querier);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("does not take a query's known-answer records for an announcement", async () => {
    const { service } = await enabledService();
    // The same record set, with the QR bit cleared: a querier listing what it already knows.
    const knownAnswers = announcementFrom('192.168.1.44', 'known-box');
    knownAnswers.writeUInt16BE(0x0000, 2);
    feed(service, knownAnswers, '192.168.1.44');

    expect(service.listDiscoveredPeers()).toEqual([]);
  });
});

describe('HubPoolMdnsService — Discovery Candidates', () => {
  it('lists a heard Hub as an unverified row, addressed by the datagram sender and not its A record', async () => {
    const { service } = await enabledService();
    // The packet claims 10.0.0.99; the datagram came from 192.168.1.42. Only the second is a fact.
    feed(service, announcementFrom('10.0.0.99', 'peer-box'), '192.168.1.42');

    expect(service.getDiscoverableCandidates(new Set())).toEqual([
      {
        tailscaleDeviceId: '',
        nodeFqdn: 'peer-box.local',
        hostname: 'peer-box',
        source: 'mdns',
        verified: false,
        address: '192.168.1.42:5002',
      },
    ]);
  });

  it('ignores a MagicDNS name an older build still puts in its TXT record', async () => {
    // A #1665-build Hub, or anything imitating one. The name used to become the row's nodeFqdn, and
    // so the host the Pair button dialled with this Hub's name, a fresh peer token and a typed PIN.
    const { service } = await enabledService();
    const claim = buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'core-9', 5002, '192.168.1.50', {
      isCiHub: 'true',
      poolProtocol: '2',
      hostname: 'core-9',
      nodeFqdn: 'attacker.example.com',
    });
    feed(service, claim, '192.168.1.50');

    const [row] = service.getDiscoverableCandidates(new Set());
    expect(row?.nodeFqdn).toBe('core-9.local');
    expect(JSON.stringify(row)).not.toContain('attacker.example.com');
  });

  it('drops an announcement whose claimed host name is not a single DNS label', async () => {
    const { service } = await enabledService();
    feed(service, announcementFrom('192.168.1.51', 'bad_label'), '192.168.1.51');
    feed(service, buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, '-dash', 5002, '192.168.1.52', { isCiHub: 'true' }), '192.168.1.52');

    expect(service.listDiscoveredPeers()).toEqual([]);
  });

  it('leaves out its own echo, and a Hub that shares a label with a paired peer', async () => {
    const { service } = await enabledService();
    hear(service, SELF_IP, SELF_HOST);
    hear(service, '192.168.1.60', 'core-9');
    hear(service, '192.168.1.61', 'loft-hub');

    const rows = service.getDiscoverableCandidates(new Set(['core-9.tailxyz.ts.net']));
    expect(rows.map((row) => row.hostname)).toEqual(['loft-hub']);
  });
});

describe('mergePoolCandidates — unverified mDNS rows', () => {
  // Shaped exactly as `listDiscoverableDevices` emits one — no device id here on purpose, so a
  // back-fill would be visible.
  const tailnetRow: DiscoverablePoolPeer = { tailscaleDeviceId: '', nodeFqdn: 'core-9.tailxyz.ts.net', hostname: 'core-9' };
  const portalRow: DiscoverablePoolPeer = { tailscaleDeviceId: '', nodeFqdn: 'loft-hub.tailxyz.ts.net', hostname: 'loft-hub', source: 'portal' };
  /** What a Hub on the #1665 build produced from a packet claiming a tailnet name. */
  const claimOn = (row: DiscoverablePoolPeer): DiscoverablePoolPeer => ({
    tailscaleDeviceId: 'from-the-packet',
    nodeFqdn: row.nodeFqdn,
    hostname: row.hostname,
    source: 'mdns',
    address: '172.18.0.66:5002',
  });

  it('never overwrites or back-fills a field of a tailnet row, even from a row claiming its FQDN', () => {
    expect(mergePoolCandidates([tailnetRow], [claimOn(tailnetRow)])).toEqual([tailnetRow]);
  });

  it('never overwrites or back-fills a field of a Portal row either', () => {
    expect(mergePoolCandidates([], [portalRow, claimOn(portalRow)])).toEqual([portalRow]);
    // Order inside `others` does not matter: an attested row that arrives after the mDNS one still
    // wins, untouched.
    expect(mergePoolCandidates([], [claimOn(portalRow), portalRow])).toEqual([portalRow]);
  });

  it('drops an mDNS row that shares a host label with an attested row, rather than show a lookalike', () => {
    const lookalike: DiscoverablePoolPeer = {
      tailscaleDeviceId: '',
      nodeFqdn: 'core-9.local',
      hostname: 'core-9',
      source: 'mdns',
      address: '172.18.0.66:5002',
    };

    expect(mergePoolCandidates([tailnetRow], [lookalike])).toEqual([tailnetRow]);
  });

  it('marks an mDNS-only row unverified, whatever its producer said, and lists it after every attested row', () => {
    const lanOnly: DiscoverablePoolPeer = {
      tailscaleDeviceId: '',
      nodeFqdn: 'isolated.local',
      hostname: 'isolated',
      source: 'mdns',
      address: '192.168.1.43:5002',
    };

    const merged = mergePoolCandidates([], [lanOnly, portalRow]);

    expect(merged).toEqual([portalRow, { ...lanOnly, verified: false }]);
  });
});

describe('HubPoolMdnsService — discovered peer cache bounds', () => {
  const T0 = Date.parse('2026-09-29T12:00:00Z');

  async function newService(): Promise<HubPoolMdnsService> {
    return (await enabledService()).service;
  }

  it('never holds more than MDNS_MAX_DISCOVERED_PEERS entries, evicting the least recently seen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = await newService();
    const total = MDNS_MAX_DISCOVERED_PEERS + 36;

    for (let i = 0; i < total; i++) {
      vi.setSystemTime(T0 + i);
      hear(service, peerIp(i));
    }

    expect((service as unknown as PeerStore).discovered.size).toBe(MDNS_MAX_DISCOVERED_PEERS);
    const ips = new Set(service.listDiscoveredPeers(T0 + total).map((peer) => peer.ip));
    // Exactly the newest MDNS_MAX_DISCOVERED_PEERS survive.
    expect(ips.has(peerIp(0))).toBe(false);
    expect(ips.has(peerIp(total - MDNS_MAX_DISCOVERED_PEERS - 1))).toBe(false);
    expect(ips.has(peerIp(total - MDNS_MAX_DISCOVERED_PEERS))).toBe(true);
    expect(ips.has(peerIp(total - 1))).toBe(true);
  });

  it('keeps a peer that re-announces and evicts the stalest one instead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = await newService();

    for (let i = 0; i < MDNS_MAX_DISCOVERED_PEERS; i++) {
      vi.setSystemTime(T0 + i);
      hear(service, peerIp(i));
    }
    vi.setSystemTime(T0 + 1_000);
    hear(service, peerIp(0)); // peer 0 is now the freshest
    vi.setSystemTime(T0 + 1_001);
    hear(service, '10.99.0.1');

    const ips = new Set(service.listDiscoveredPeers(T0 + 1_002).map((peer) => peer.ip));
    expect(ips.size).toBe(MDNS_MAX_DISCOVERED_PEERS);
    expect(ips.has(peerIp(0))).toBe(true);
    expect(ips.has(peerIp(1))).toBe(false);
    expect(ips.has('10.99.0.1')).toBe(true);
  });

  it('drops expired peers before evicting fresh ones, and still expires peers by TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = await newService();

    vi.setSystemTime(T0);
    for (let i = 0; i < MDNS_MAX_DISCOVERED_PEERS; i++) hear(service, peerIp(i));

    vi.setSystemTime(T0 + MDNS_PEER_TTL_MS + 1);
    hear(service, '10.99.0.2');
    expect((service as unknown as PeerStore).discovered.size).toBe(1);

    expect(service.listDiscoveredPeers(T0 + 2 * MDNS_PEER_TTL_MS + 2)).toEqual([]);
  });

  it('keys the cache on the real sender, so one box cannot fill it by varying the A record it claims', async () => {
    const service = await newService();

    for (let i = 0; i < MDNS_MAX_DISCOVERED_PEERS; i++) feed(service, announcementFrom(peerIp(i)), '172.18.0.66');

    expect(service.listDiscoveredPeers().map((peer) => peer.ip)).toEqual(['172.18.0.66']);
  });

  it('keys the cache on the sender alone, so varying the SRV port cannot fill it and evict a real Hub', async () => {
    // The SRV port is as much the sender's choice as the A record. With it in the key, 100 packets
    // from one box made 64 rows and pushed every genuine Hub out of the cache.
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = await newService();
    vi.setSystemTime(T0);
    hear(service, '192.168.1.20', 'real-hub');

    for (let i = 0; i < 100; i++) {
      vi.setSystemTime(T0 + 1 + i);
      feed(service, buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'flood', 10_000 + i, '10.0.0.1', { isCiHub: 'true' }), '172.18.0.66');
    }

    expect((service as unknown as PeerStore).discovered.size).toBe(2);
    const peers = service.listDiscoveredPeers(T0 + 101);
    expect(peers.map((peer) => peer.ip).sort()).toEqual(['172.18.0.66', '192.168.1.20']);
    // The sender's latest announcement replaced its row rather than adding one beside it.
    expect(peers.find((peer) => peer.ip === '172.18.0.66')?.port).toBe(10_099);
    expect(peers.find((peer) => peer.ip === '192.168.1.20')?.hostname).toBe('real-hub');
  });

  it('keeps one row per sender: two senders are two rows, and a re-announcement replaces its own', async () => {
    const service = await newService();
    feed(service, buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'hub-a', 5002, '192.168.1.31', { isCiHub: 'true' }), '192.168.1.31');
    feed(service, buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'hub-b', 5002, '192.168.1.32', { isCiHub: 'true' }), '192.168.1.32');
    feed(service, buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, 'hub-a-renamed', 3000, '192.168.1.31', { isCiHub: 'true' }), '192.168.1.31');

    const rows = service
      .getDiscoverableCandidates(new Set())
      .map((row) => ({ hostname: row.hostname, address: row.address }))
      .sort((a, b) => (a.address ?? '').localeCompare(b.address ?? ''));
    expect(rows).toEqual([
      { hostname: 'hub-a-renamed', address: '192.168.1.31:3000' },
      { hostname: 'hub-b', address: '192.168.1.32:5002' },
    ]);
  });

  it('drops a hostile datagram in the packet handler without recording or throwing', async () => {
    const service = await newService();
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
    const service = new HubPoolMdnsService(logger, poolSettings({ hubPoolMdnsEnabled: true }));

    await withTimeout(service.onModuleInit(), 1_000, 'onModuleInit');

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));
    expect(socket.close).toHaveBeenCalled();
    expect(service.isActive()).toBe(false);
    service.scan();
    service.announce();
    expect(socket.send).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('keeps serving datagrams after a hostile one arrives on the bound socket', async () => {
    const { service, socket } = await enabledService();
    const rinfo = { address: '172.18.0.9', family: 'IPv4', port: 5353, size: 14 };
    const selfPointer = Buffer.concat([dnsHeader({ an: 1 }), pointer(12)]);
    runWithWatchdog(() => socket.emit('message', selfPointer, rinfo));
    socket.emit('message', announcementFrom('192.168.1.77', 'late-peer'), rinfo);

    expect(service.listDiscoveredPeers().map((peer) => peer.hostname)).toEqual(['late-peer']);
  });
});
