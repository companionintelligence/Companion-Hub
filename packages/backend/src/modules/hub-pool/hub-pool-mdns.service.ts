import dgram, { type Socket } from 'node:dgram';
import os from 'node:os';
import { Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import type { DiscoverablePoolPeer } from './hub-pool.types';

export const MDNS_MULTICAST_IPV4 = '224.0.0.251';
export const MDNS_PORT = 5353;
export const CIHUB_SERVICE_TYPE = '_cihub._tcp.local';
export const CIHUB_COMPAT_SERVICE_TYPE = '_ci-hub._tcp.local';

/** TTL for cached mDNS peer discoveries (60 seconds). */
export const MDNS_PEER_TTL_MS = 60_000;

/**
 * Most peers the discovery cache will hold at once. Any container on the Hub's docker networks can
 * reach the socket with unicast datagrams, and every distinct `ip:port` it claims would otherwise
 * become a new entry, so without a ceiling one sender could grow the map without limit. 64 is far
 * more Hubs than share any real LAN.
 */
export const MDNS_MAX_DISCOVERED_PEERS = 64;

export interface DiscoveredMdnsPeer {
  nodeFqdn: string | null;
  hostname: string;
  ip: string;
  port: number;
  poolProtocol: number | null;
  isCiHub: boolean;
  lastSeenAt: number;
}

/**
 * mDNS Zero-Conf Broadcaster and Listener for CI-Hub LAN Peer Discovery.
 * Inspired by NVIDIA PAIR, announces this Hub on the local subnet via `_cihub._tcp.local`
 * and discovers other Hubs on the same physical network so operators can pair them
 * with just a 6-digit PIN without having to manually look up and type IP addresses.
 */
@Injectable()
export class HubPoolMdnsService implements OnModuleInit, OnModuleDestroy {
  private socket: Socket | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private readonly discovered = new Map<string, DiscoveredMdnsPeer>();
  private isListening = false;

  constructor(
    private readonly logger: LoggerService,
    @Optional() private readonly tailscale?: TailscaleService,
  ) {}

  async onModuleInit(): Promise<void> {
    // In unit test runner without explicit activation, skip binding UDP ports to prevent collisions
    if (process.env.NODE_ENV === 'test' && !process.env.HUB_POOL_ENABLE_MDNS_TEST) {
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.socket) return;

    try {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;

      socket.on('error', (err) => {
        this.logger.debug(`[HubPool:mDNS] Socket error: ${err.message}`);
      });

      // handleIncomingPacket never throws: every datagram, from any sender, is parsed inside its
      // try/catch and a malformed one is simply dropped.
      socket.on('message', (msg, rinfo) => {
        this.handleIncomingPacket(msg, rinfo.address);
      });

      // dgram reports a failed bind only as an 'error' event and never calls the bind callback, so a
      // promise that settled from the callback alone would stay pending forever — and because
      // onModuleInit awaits it, so would Nest bootstrap. That is the normal outcome on a host-network
      // run where the OS's own mDNS responder already holds 5353, so listen for the error as well.
      await new Promise<void>((resolve, reject) => {
        const onBindError = (err: Error) => reject(err);
        socket.once('error', onBindError);
        socket.bind(MDNS_PORT, () => {
          socket.off('error', onBindError);
          try {
            socket.addMembership(MDNS_MULTICAST_IPV4);
            socket.setMulticastTTL(255);
            socket.setMulticastLoopback(true);
            this.isListening = true;
            this.logger.debug(`[HubPool:mDNS] Listening on ${MDNS_MULTICAST_IPV4}:${MDNS_PORT}`);
          } catch (e) {
            this.logger.debug(`[HubPool:mDNS] Membership configuration notice: ${e instanceof Error ? e.message : String(e)}`);
          }
          resolve();
        });
      });

      // Send initial announcement and arm periodic broadcast (every 30s)
      await this.announce();
      this.broadcastTimer = setInterval(() => {
        void this.announce();
        this.pruneStalePeers();
      }, 30_000);
    } catch (error) {
      // LAN discovery is a convenience; the Hub is fully usable without it (peers can still be
      // paired over the tailnet or by address), so say so once and carry on rather than fail boot.
      this.logger.warn(
        `[HubPool:mDNS] Could not start on UDP port ${MDNS_PORT}; LAN peer discovery is disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.socket) {
      try {
        if (this.isListening) {
          try {
            this.socket.dropMembership(MDNS_MULTICAST_IPV4);
          } catch {
            // Ignore drop errors on shutdown
          }
        }
        this.socket.close();
      } catch {
        // Ignore close errors
      }
      this.socket = null;
      this.isListening = false;
    }
  }

  /**
   * Broadcast mDNS announcement for this node.
   */
  async announce(): Promise<void> {
    if (!this.socket) return;
    try {
      const port = Number(process.env.API_PORT ?? process.env.BACKEND_PORT ?? process.env.PORT ?? 5002);
      const host = os.hostname().replace(/\.local$/, '');
      const lanIps = this.getLocalLanIpv4Addresses();
      if (lanIps.length === 0) return;

      const tailnetStatus = await this.tailscale?.getStatusCached();
      const nodeFqdn = tailnetStatus?.nodeFqdn ?? '';

      const txtRecord = {
        txtvers: '1',
        isCiHub: 'true',
        poolProtocol: '2',
        hostname: host,
        nodeFqdn,
      };

      for (const ip of lanIps) {
        const packet = buildMdnsAnnouncement(CIHUB_SERVICE_TYPE, host, port, ip, txtRecord);
        this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_IPV4);

        // Also broadcast compatibility packet for desktop discovery
        const compatPacket = buildMdnsAnnouncement(CIHUB_COMPAT_SERVICE_TYPE, host, port, ip, txtRecord);
        this.socket.send(compatPacket, 0, compatPacket.length, MDNS_PORT, MDNS_MULTICAST_IPV4);
      }
    } catch (err) {
      this.logger.debug(`[HubPool:mDNS] Broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query the LAN for all active `_cihub._tcp` peers.
   */
  async scan(): Promise<void> {
    if (!this.socket) return;
    try {
      const query = buildMdnsQuery(CIHUB_SERVICE_TYPE);
      this.socket.send(query, 0, query.length, MDNS_PORT, MDNS_MULTICAST_IPV4);
      const compatQuery = buildMdnsQuery(CIHUB_COMPAT_SERVICE_TYPE);
      this.socket.send(compatQuery, 0, compatQuery.length, MDNS_PORT, MDNS_MULTICAST_IPV4);
    } catch (err) {
      this.logger.debug(`[HubPool:mDNS] Scan query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Returns discovered peers that are still fresh.
   */
  listDiscoveredPeers(now = Date.now()): DiscoveredMdnsPeer[] {
    const fresh: DiscoveredMdnsPeer[] = [];
    for (const [key, peer] of this.discovered.entries()) {
      if (now - peer.lastSeenAt <= MDNS_PEER_TTL_MS) {
        fresh.push(peer);
      } else {
        this.discovered.delete(key);
      }
    }
    return fresh;
  }

  /**
   * Transforms discovered mDNS peers into DiscoverablePoolPeer candidates.
   */
  async getDiscoverableCandidates(knownPeersFqdn: Set<string>): Promise<DiscoverablePoolPeer[]> {
    const peers = this.listDiscoveredPeers();
    const selfIps = new Set(this.getLocalLanIpv4Addresses());
    const selfHost = os
      .hostname()
      .toLowerCase()
      .replace(/\.local$/, '');
    const selfTailnet = await this.tailscale?.getStatusCached();
    const selfFqdn = selfTailnet?.nodeFqdn?.toLowerCase();

    const candidates: DiscoverablePoolPeer[] = [];
    for (const peer of peers) {
      // Exclude self by IP, hostname, or FQDN
      if (selfIps.has(peer.ip) || peer.hostname.toLowerCase() === selfHost) continue;
      if (peer.nodeFqdn && selfFqdn && peer.nodeFqdn.toLowerCase() === selfFqdn) continue;

      // Exclude if already paired by FQDN
      if (peer.nodeFqdn && knownPeersFqdn.has(peer.nodeFqdn.toLowerCase())) continue;

      const fqdn = peer.nodeFqdn || `${peer.hostname}.local`;
      candidates.push({
        tailscaleDeviceId: '',
        nodeFqdn: fqdn,
        hostname: peer.hostname,
        source: 'mdns',
        address: `${peer.ip}:${peer.port}`,
      });
    }

    return candidates;
  }

  private handleIncomingPacket(buffer: Buffer, senderAddress: string): void {
    try {
      const parsed = parseMdnsPacket(buffer);
      if (!parsed) return;

      const isCihubService = parsed.services.some((s) => s.includes('_cihub._tcp') || s.includes('_ci-hub._tcp'));
      if (!isCihubService && !parsed.txt.isCiHub) return;

      const hostname = parsed.hostname || parsed.srvTarget?.split('.')[0] || 'hub-peer';
      const port = parsed.port || 5002;
      const ip = parsed.ip || senderAddress;
      const key = `${ip}:${port}`;
      const now = Date.now();

      this.makeRoomFor(key, now);
      this.discovered.set(key, {
        nodeFqdn: parsed.txt.nodeFqdn || null,
        hostname,
        ip,
        port,
        poolProtocol: parsed.txt.poolProtocol ? Number(parsed.txt.poolProtocol) : 2,
        isCiHub: parsed.txt.isCiHub === 'true' || isCihubService,
        lastSeenAt: now,
      });
    } catch {
      // Ignore packet parse failures
    }
  }

  /**
   * Keeps the cache within {@link MDNS_MAX_DISCOVERED_PEERS} before a new key goes in. Expired peers
   * go first, since they would be pruned anyway; only if the cache is still full of fresh ones is
   * the least recently seen evicted. A genuine Hub re-announces every 30s, so evicting by staleness
   * rather than refusing newcomers means a flood can crowd a real peer out only briefly, never lock
   * it out for a whole TTL. A key already present is a refresh and needs no room.
   */
  private makeRoomFor(key: string, now: number): void {
    if (this.discovered.has(key) || this.discovered.size < MDNS_MAX_DISCOVERED_PEERS) return;

    this.pruneStalePeers(now);

    while (this.discovered.size >= MDNS_MAX_DISCOVERED_PEERS) {
      let stalestKey: string | null = null;
      let stalestSeenAt = Number.POSITIVE_INFINITY;
      for (const [candidate, peer] of this.discovered) {
        if (peer.lastSeenAt < stalestSeenAt) {
          stalestKey = candidate;
          stalestSeenAt = peer.lastSeenAt;
        }
      }
      if (stalestKey === null) return;
      this.discovered.delete(stalestKey);
    }
  }

  private pruneStalePeers(now = Date.now()): void {
    for (const [key, peer] of this.discovered.entries()) {
      if (now - peer.lastSeenAt > MDNS_PEER_TTL_MS) {
        this.discovered.delete(key);
      }
    }
  }

  private getLocalLanIpv4Addresses(): string[] {
    const interfaces = os.networkInterfaces();
    const addresses: string[] = [];
    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          addresses.push(addr.address);
        }
      }
    }
    return addresses;
  }
}

// ── DNS Packet Encoding and Decoding Helpers ──

export interface ParsedMdnsPacket {
  services: string[];
  hostname: string | null;
  srvTarget: string | null;
  port: number | null;
  ip: string | null;
  txt: Record<string, string>;
}

export function encodeDnsName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'utf8');
    buffers.push(Buffer.from([buf.length]), buf);
  }
  buffers.push(Buffer.from([0]));
  return Buffer.concat(buffers);
}

/** RFC 1035 §2.3.4: a whole name on the wire, length octets and the root label included, is at most 255 octets. */
export const MAX_DNS_NAME_WIRE_LENGTH = 255;

/**
 * Most compression pointers followed across all the names in one packet. The backward-only rule in
 * {@link decodeDnsName} already guarantees each walk ends; this bounds what a whole datagram can
 * cost. A per-name cap would not: two bytes of pointer can expand into a 255-octet name of 127
 * labels, so a 64 KB datagram of records all pointing at one such name took ~144 ms of event-loop
 * time to parse on a developer laptop — a few hundred KB/s of datagrams would keep the Hub pinned.
 * Sharing the budget holds that to 128 expansions per packet, which brings every packet shape down
 * to a few ms per 64 KB. Hub announcements are uncompressed and real encoders spend one or two
 * pointers per name, so nothing a Hub needs to read comes close.
 */
export const MAX_DNS_POINTER_HOPS = 128;

/** Compression-pointer hops still allowed; one budget is shared by every name read from a packet. */
export interface DnsPointerBudget {
  remaining: number;
}

/** Thrown for any packet the decoder refuses; {@link parseMdnsPacket} turns it into `null`. */
export class MalformedDnsPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedDnsPacketError';
  }
}

/**
 * Decodes the (possibly compressed) name at `offset`, throwing {@link MalformedDnsPacketError} for
 * anything that is not a well-formed name.
 *
 * Every byte this reads comes from whoever sent the datagram, and the parse runs synchronously on
 * the event loop, so a name that never ends would freeze the whole Hub — the API and the pool proxy
 * with it, and without the process exiting, so no restart policy would notice. The classic way to
 * build one is a compression pointer aimed at itself (a 14-byte packet does it). RFC 1035 §4.1.4
 * says a pointer refers to a *prior* occurrence of a name, so each pointer here must land strictly
 * before the previous one's target (the first before the name's own start). Pointer targets
 * therefore only ever decrease, which rules out every loop; the 255-octet length cap and the
 * pointer `budget` (shared across a packet, see {@link MAX_DNS_POINTER_HOPS}) then bound the work.
 */
export function decodeDnsName(
  buffer: Buffer,
  offset: number,
  budget: DnsPointerBudget = { remaining: MAX_DNS_POINTER_HOPS },
): { name: string; nextOffset: number } {
  if (!Number.isInteger(offset) || offset < 0 || offset >= buffer.length) {
    throw new MalformedDnsPacketError(`name at offset ${offset} starts outside the packet`);
  }

  const parts: string[] = [];
  let curr = offset;
  let barrier = offset;
  let wireLength = 0;
  let nextOffset = -1;

  for (;;) {
    const len = buffer[curr];
    if (len === undefined) {
      throw new MalformedDnsPacketError('name runs past the end of the packet');
    }
    if (len === 0) {
      if (nextOffset === -1) nextOffset = curr + 1;
      break;
    }

    const labelType = len & 0xc0;
    // Compression pointer (top 2 bits set: 0b11xxxxxx)
    if (labelType === 0xc0) {
      const low = buffer[curr + 1];
      if (low === undefined) {
        throw new MalformedDnsPacketError('name runs past the end of the packet');
      }
      const target = ((len & 0x3f) << 8) | low;
      if (target >= barrier) {
        throw new MalformedDnsPacketError(`compression pointer to ${target} does not point backward (must be below ${barrier})`);
      }
      if (budget.remaining <= 0) {
        throw new MalformedDnsPacketError(`packet follows more than ${MAX_DNS_POINTER_HOPS} compression pointer hops`);
      }
      budget.remaining -= 1;
      // The name continues in the packet after the first pointer, however far the chain goes.
      if (nextOffset === -1) nextOffset = curr + 2;
      barrier = target;
      curr = target;
      continue;
    }
    // 0b01 and 0b10 are the extended label types RFC 6891 retired; nothing legitimate sends them.
    if (labelType !== 0) {
      throw new MalformedDnsPacketError(`unsupported label type 0x${labelType.toString(16)}`);
    }

    // Count the root octet that must still follow, so the limit covers the finished name.
    wireLength += 1 + len;
    if (wireLength + 1 > MAX_DNS_NAME_WIRE_LENGTH) {
      throw new MalformedDnsPacketError(`name is longer than ${MAX_DNS_NAME_WIRE_LENGTH} octets`);
    }
    const labelStart = curr + 1;
    const labelEnd = labelStart + len;
    if (labelEnd > buffer.length) {
      throw new MalformedDnsPacketError('name runs past the end of the packet');
    }
    parts.push(buffer.subarray(labelStart, labelEnd).toString('utf8'));
    curr = labelEnd;
  }

  return { name: parts.join('.'), nextOffset };
}

export function buildMdnsQuery(serviceName: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID = 0
  header.writeUInt16BE(0x0000, 2); // Standard query
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  header.writeUInt16BE(0, 6); // ANCOUNT = 0
  header.writeUInt16BE(0, 8); // NSCOUNT = 0
  header.writeUInt16BE(0, 10); // ARCOUNT = 0

  const qName = encodeDnsName(serviceName);
  const qTypeAndClass = Buffer.alloc(4);
  qTypeAndClass.writeUInt16BE(12, 0); // Type 12 (PTR)
  qTypeAndClass.writeUInt16BE(1, 2); // Class 1 (IN)

  return Buffer.concat([header, qName, qTypeAndClass]);
}

export function buildMdnsAnnouncement(serviceType: string, hostname: string, port: number, ip: string, txtRecord: Record<string, string>): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID = 0
  header.writeUInt16BE(0x8400, 2); // Response, Authoritative
  header.writeUInt16BE(0, 4); // QDCOUNT = 0
  header.writeUInt16BE(4, 6); // ANCOUNT = 4 (PTR, SRV, TXT, A)
  header.writeUInt16BE(0, 8); // NSCOUNT = 0
  header.writeUInt16BE(0, 10); // ARCOUNT = 0

  const instanceName = `${hostname}.${serviceType}`;
  const targetHost = `${hostname}.local`;

  // 1. PTR Record: serviceType -> instanceName
  const ptrName = encodeDnsName(serviceType);
  const ptrData = encodeDnsName(instanceName);
  const ptrMeta = Buffer.alloc(10);
  ptrMeta.writeUInt16BE(12, 0); // Type PTR
  ptrMeta.writeUInt16BE(0x8001, 2); // Class IN + flush cache
  ptrMeta.writeUInt32BE(120, 4); // TTL = 120s
  ptrMeta.writeUInt16BE(ptrData.length, 8); // RDLENGTH
  const ptrRecord = Buffer.concat([ptrName, ptrMeta, ptrData]);

  // 2. SRV Record: instanceName -> targetHost:port
  const srvName = encodeDnsName(instanceName);
  const srvTarget = encodeDnsName(targetHost);
  const srvBody = Buffer.alloc(6);
  srvBody.writeUInt16BE(0, 0); // Priority
  srvBody.writeUInt16BE(0, 2); // Weight
  srvBody.writeUInt16BE(port, 4); // Port
  const srvRdata = Buffer.concat([srvBody, srvTarget]);
  const srvMeta = Buffer.alloc(10);
  srvMeta.writeUInt16BE(33, 0); // Type SRV
  srvMeta.writeUInt16BE(0x8001, 2); // Class IN
  srvMeta.writeUInt32BE(120, 4); // TTL
  srvMeta.writeUInt16BE(srvRdata.length, 8);
  const srvRecord = Buffer.concat([srvName, srvMeta, srvRdata]);

  // 3. TXT Record
  const txtName = encodeDnsName(instanceName);
  const txtBuffers: Buffer[] = [];
  for (const [k, v] of Object.entries(txtRecord)) {
    const pair = `${k}=${v}`;
    const b = Buffer.from(pair, 'utf8');
    txtBuffers.push(Buffer.from([b.length]), b);
  }
  const txtData = Buffer.concat(txtBuffers);
  const txtMeta = Buffer.alloc(10);
  txtMeta.writeUInt16BE(16, 0); // Type TXT
  txtMeta.writeUInt16BE(0x8001, 2); // Class IN
  txtMeta.writeUInt32BE(120, 4); // TTL
  txtMeta.writeUInt16BE(txtData.length, 8);
  const txtFullRecord = Buffer.concat([txtName, txtMeta, txtData]);

  // 4. A Record: targetHost -> ip
  const aName = encodeDnsName(targetHost);
  const ipParts = ip.split('.').map(Number);
  const aData = Buffer.from(ipParts);
  const aMeta = Buffer.alloc(10);
  aMeta.writeUInt16BE(1, 0); // Type A
  aMeta.writeUInt16BE(0x8001, 2); // Class IN
  aMeta.writeUInt32BE(120, 4); // TTL
  aMeta.writeUInt16BE(aData.length, 8);
  const aRecord = Buffer.concat([aName, aMeta, aData]);

  return Buffer.concat([header, ptrRecord, srvRecord, txtFullRecord, aRecord]);
}

/**
 * Parses an mDNS datagram, returning `null` for anything malformed — truncated, over-long, or built
 * to trip up the decoder. The socket handler sees every datagram sent to 5353 by anything on the
 * Hub's networks, so dropping a bad packet is the only safe outcome; a partial parse of one is not.
 */
export function parseMdnsPacket(buffer: Buffer): ParsedMdnsPacket | null {
  try {
    return readMdnsPacket(buffer);
  } catch {
    return null;
  }
}

function readMdnsPacket(buffer: Buffer): ParsedMdnsPacket {
  if (buffer.length < 12) throw new MalformedDnsPacketError('packet is shorter than a DNS header');
  const qdCount = buffer.readUInt16BE(4);
  const anCount = buffer.readUInt16BE(6);

  const pointerBudget: DnsPointerBudget = { remaining: MAX_DNS_POINTER_HOPS };
  let offset = 12;

  // Skip questions
  for (let i = 0; i < qdCount; i++) {
    const decoded = decodeDnsName(buffer, offset, pointerBudget);
    offset = decoded.nextOffset + 4; // skip type (2) and class (2)
    if (offset > buffer.length) throw new MalformedDnsPacketError('question runs past the end of the packet');
  }

  const result: ParsedMdnsPacket = {
    services: [],
    hostname: null,
    srvTarget: null,
    port: null,
    ip: null,
    txt: {},
  };

  for (let i = 0; i < anCount; i++) {
    if (offset >= buffer.length) throw new MalformedDnsPacketError(`header promises ${anCount} answers, packet holds ${i}`);
    const nameDecoded = decodeDnsName(buffer, offset, pointerBudget);
    offset = nameDecoded.nextOffset;
    if (offset + 10 > buffer.length) throw new MalformedDnsPacketError('record header runs past the end of the packet');

    const rType = buffer.readUInt16BE(offset);
    const rdLength = buffer.readUInt16BE(offset + 8);
    offset += 10;
    const rdataEnd = offset + rdLength;
    if (rdataEnd > buffer.length) throw new MalformedDnsPacketError('record data runs past the end of the packet');

    if (rType === 12) {
      // PTR
      const ptr = decodeDnsName(buffer, offset, pointerBudget);
      if (ptr.nextOffset > rdataEnd) throw new MalformedDnsPacketError('PTR name runs past its RDLENGTH');
      result.services.push(nameDecoded.name);
      if (ptr.name) result.srvTarget = ptr.name;
    } else if (rType === 33 && rdLength >= 6) {
      // SRV: priority(2) + weight(2) + port(2) + target
      result.port = buffer.readUInt16BE(offset + 4);
      const target = decodeDnsName(buffer, offset + 6, pointerBudget);
      if (target.nextOffset > rdataEnd) throw new MalformedDnsPacketError('SRV target runs past its RDLENGTH');
      result.srvTarget = target.name;
    } else if (rType === 16) {
      // TXT
      let txtOffset = offset;
      const end = rdataEnd;
      while (txtOffset < end) {
        const itemLen = buffer[txtOffset];
        if (itemLen === undefined) throw new MalformedDnsPacketError('TXT data runs past the end of the packet');
        txtOffset += 1;
        if (txtOffset + itemLen > end) throw new MalformedDnsPacketError('TXT string runs past its RDLENGTH');
        const itemStr = buffer.subarray(txtOffset, txtOffset + itemLen).toString('utf8');
        const eqIdx = itemStr.indexOf('=');
        if (eqIdx !== -1) {
          result.txt[itemStr.slice(0, eqIdx)] = itemStr.slice(eqIdx + 1);
        }
        txtOffset += itemLen;
      }
    } else if (rType === 1 && rdLength === 4) {
      // A (IPv4)
      const b0 = buffer[offset];
      const b1 = buffer[offset + 1];
      const b2 = buffer[offset + 2];
      const b3 = buffer[offset + 3];
      if (b0 !== undefined && b1 !== undefined && b2 !== undefined && b3 !== undefined) {
        result.ip = `${b0}.${b1}.${b2}.${b3}`;
      }
    }

    offset += rdLength;
  }

  if (result.txt.hostname) {
    result.hostname = result.txt.hostname;
  }

  return result;
}
