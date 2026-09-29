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
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        this.logger.debug(`[HubPool:mDNS] Socket error: ${err.message}`);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleIncomingPacket(msg, rinfo.address);
      });

      await new Promise<void>((resolve) => {
        this.socket?.bind(MDNS_PORT, () => {
          try {
            this.socket?.addMembership(MDNS_MULTICAST_IPV4);
            this.socket?.setMulticastTTL(255);
            this.socket?.setMulticastLoopback(true);
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
      this.logger.debug(`[HubPool:mDNS] Service failed to bind port ${MDNS_PORT}: ${error instanceof Error ? error.message : String(error)}`);
      this.socket = null;
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

      this.discovered.set(key, {
        nodeFqdn: parsed.txt.nodeFqdn || null,
        hostname,
        ip,
        port,
        poolProtocol: parsed.txt.poolProtocol ? Number(parsed.txt.poolProtocol) : 2,
        isCiHub: parsed.txt.isCiHub === 'true' || isCihubService,
        lastSeenAt: Date.now(),
      });
    } catch {
      // Ignore packet parse failures
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

export function decodeDnsName(buffer: Buffer, offset: number): { name: string; nextOffset: number } {
  const parts: string[] = [];
  let curr = offset;
  let jumped = false;
  let nextOffset = -1;

  while (curr < buffer.length) {
    const len = buffer[curr];
    if (len === undefined || len === 0) {
      if (!jumped) nextOffset = curr + 1;
      break;
    }
    // Compression pointer (top 2 bits set: 0b11xxxxxx)
    if ((len & 0xc0) === 0xc0) {
      if (curr + 1 >= buffer.length) break;
      const nextByte = buffer[curr + 1];
      if (nextByte === undefined) break;
      const pointer = ((len & 0x3f) << 8) | nextByte;
      if (!jumped) nextOffset = curr + 2;
      curr = pointer;
      jumped = true;
      continue;
    }
    curr += 1;
    if (curr + len > buffer.length) break;
    parts.push(buffer.subarray(curr, curr + len).toString('utf8'));
    curr += len;
  }

  if (nextOffset === -1) nextOffset = curr + 1;
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

export function parseMdnsPacket(buffer: Buffer): ParsedMdnsPacket | null {
  if (buffer.length < 12) return null;
  const qdCount = buffer.readUInt16BE(4);
  const anCount = buffer.readUInt16BE(6);

  let offset = 12;

  // Skip questions
  for (let i = 0; i < qdCount; i++) {
    const decoded = decodeDnsName(buffer, offset);
    offset = decoded.nextOffset + 4; // skip type (2) and class (2)
    if (offset > buffer.length) return null;
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
    if (offset >= buffer.length) break;
    const nameDecoded = decodeDnsName(buffer, offset);
    offset = nameDecoded.nextOffset;
    if (offset + 10 > buffer.length) break;

    const rType = buffer.readUInt16BE(offset);
    const rdLength = buffer.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdLength > buffer.length) break;

    if (rType === 12) {
      // PTR
      const ptr = decodeDnsName(buffer, offset);
      result.services.push(nameDecoded.name);
      if (ptr.name) result.srvTarget = ptr.name;
    } else if (rType === 33 && rdLength >= 6) {
      // SRV: priority(2) + weight(2) + port(2) + target
      result.port = buffer.readUInt16BE(offset + 4);
      const target = decodeDnsName(buffer, offset + 6);
      result.srvTarget = target.name;
    } else if (rType === 16) {
      // TXT
      let txtOffset = offset;
      const end = offset + rdLength;
      while (txtOffset < end) {
        const itemLen = buffer[txtOffset];
        if (itemLen === undefined) break;
        txtOffset += 1;
        if (txtOffset + itemLen > end) break;
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
