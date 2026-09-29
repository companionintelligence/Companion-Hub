import dgram, { type Socket } from 'node:dgram';
import os from 'node:os';
import { Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { isHubPoolEnabled } from '@/common/helpers/hub-pool';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { POOL_PROTOCOL_VERSION } from './hub-pool-peer-auth';
import type { DiscoverablePoolPeer } from './hub-pool.types';

export const MDNS_MULTICAST_IPV4 = '224.0.0.251';
export const MDNS_PORT = 5353;
export const CIHUB_SERVICE_TYPE = '_cihub._tcp.local';
export const CIHUB_COMPAT_SERVICE_TYPE = '_ci-hub._tcp.local';
/** Every service type this Hub announces and answers for: its own, and the one the desktop app's `find_hubs` browses. */
export const CIHUB_SERVICE_TYPES: readonly string[] = [CIHUB_SERVICE_TYPE, CIHUB_COMPAT_SERVICE_TYPE];

/** TTL for cached mDNS peer discoveries (60 seconds). */
export const MDNS_PEER_TTL_MS = 60_000;

/** How often this Hub re-announces itself while mDNS is on. */
export const MDNS_ANNOUNCE_INTERVAL_MS = 30_000;

/**
 * RFC 6762 §6: a responder must not multicast a record again within one second of the last time it
 * did. It is also what bounds a query flood — any container on the Hub's networks can unicast
 * queries straight at the socket, and without it each one would cost a multicast per LAN address.
 */
export const MDNS_MIN_MULTICAST_INTERVAL_MS = 1_000;

/**
 * Most peers the discovery cache will hold at once. Any container on the Hub's docker networks can
 * reach the socket with unicast datagrams, and every distinct `ip:port` it claims would otherwise
 * become a new entry, so without a ceiling one sender could grow the map without limit. 64 is far
 * more Hubs than share any real LAN.
 */
export const MDNS_MAX_DISCOVERED_PEERS = 64;

/** The settings.json keys the socket's state depends on; a write that touches neither cannot move it. */
const MDNS_GATING_SETTINGS = new Set(['hubPoolMdnsEnabled', 'hubPoolEnabled']);

/** One DNS label, as a host name uses it. A name a packet claims has to be one of these to be shown at all. */
const MDNS_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface DiscoveredMdnsPeer {
  /** The host label the announcement claims, from its SRV target. Unauthenticated: a display value only. */
  hostname: string;
  /**
   * The datagram's real sender (`rinfo.address`). Never the packet's A record: that is a field the
   * sender typed, and it is what let one packet put an arbitrary address on a Hub's name.
   */
  ip: string;
  /** From the SRV record, so claimed by the sender as well. */
  port: number;
  poolProtocol: number | null;
  lastSeenAt: number;
}

/**
 * LAN discovery over multicast DNS: announces this Hub as `_cihub._tcp.local` (and `_ci-hub._tcp.local`
 * for the desktop app), answers queries for both, and lists the Hubs it hears.
 *
 * **Opt-in, and off by default.** The socket is open only while `poolMdnsEnabled` AND the effective
 * pool master switch are both on, and it opens and closes as either changes — see
 * {@link HubPoolMdnsService.reconcile}. With it off nothing binds UDP 5353 at all and discovery
 * returns no mDNS rows. The default is off because the shipped Hub runs on Docker bridge networks,
 * where the multicast group it joins holds only its own sibling containers: on core-2 and beta-red
 * (2026-09-29) the listener reached nothing on the LAN and was reachable by every app container.
 *
 * **Nothing here is authenticated.** Every field of every datagram was chosen by whoever sent it,
 * and anything on the Hub's networks can send one. So what this service hears is never a pairing
 * candidate: each row is `source: 'mdns'`, `verified: false`, named only by the host label it claims
 * and addressed by the datagram's real sender, and {@link mergePoolCandidates} keeps it from touching
 * any tailnet- or Portal-attested row. A Hub that is really on this node's tailnet is already a
 * verified candidate from the tailnet directory, which is where pairing by name happens. That is also
 * why the announcement no longer carries this node's MagicDNS name: `GET /identify` stopped
 * disclosing it to unauthenticated callers, and a 30 s multicast beacon is no place to put it back.
 */
@Injectable()
export class HubPoolMdnsService implements OnModuleInit, OnModuleDestroy {
  private socket: Socket | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private readonly discovered = new Map<string, DiscoveredMdnsPeer>();
  private isListening = false;
  /** Per service type, when its records were last multicast — for {@link MDNS_MIN_MULTICAST_INTERVAL_MS}. */
  private readonly lastMulticastAt = new Map<string, number>();
  /** Every open and close runs on this chain, so two quick setting flips cannot interleave a bind with a close. */
  private transition: Promise<void> = Promise.resolve();
  private unsubscribeSettings: (() => void) | null = null;
  private destroyed = false;

  constructor(
    private readonly logger: LoggerService,
    // Optional so a harness that builds this service with a logger alone gets the safe answer: with
    // no settings to read, mDNS is off.
    @Optional() private readonly configuration?: ConfigurationService,
  ) {}

  async onModuleInit(): Promise<void> {
    // In unit test runner without explicit activation, skip binding UDP ports to prevent collisions
    if (process.env.NODE_ENV === 'test' && !process.env.HUB_POOL_ENABLE_MDNS_TEST) {
      return;
    }
    this.unsubscribeSettings =
      this.configuration?.onUserSettingsChanged((changedKeys) => {
        if (changedKeys.some((key) => MDNS_GATING_SETTINGS.has(key))) {
          void this.reconcile();
        }
      }) ?? null;
    await this.reconcile();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    await this.enqueue(() => this.stop());
  }

  /**
   * Whether the settings want the socket open: the operator's opt-in AND the effective pool master
   * switch, which `HUB_POOL_USER_DISABLED` in the environment can hold off regardless of the setting.
   * A Hub that has left the pool has no reason to advertise itself to one.
   */
  isEnabledBySettings(): boolean {
    const preferences = this.configuration?.getHubPoolPreferences();
    if (!preferences) return false;
    return preferences.poolMdnsEnabled === true && isHubPoolEnabled(preferences.poolEnabled);
  }

  /** Whether the socket is open right now. False means no port bound and no mDNS rows. */
  isActive(): boolean {
    return this.socket !== null;
  }

  /**
   * Open or close the socket to match {@link isEnabledBySettings}. Idempotent, and the only way the
   * socket is ever opened: it runs at boot and after every settings write that touches either switch.
   */
  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      const wanted = !this.destroyed && this.isEnabledBySettings();
      if (wanted && !this.socket) {
        await this.start();
      } else if (!wanted && this.socket) {
        await this.stop();
        this.logger.info('[HubPool:mDNS] LAN discovery is off; UDP port 5353 released');
      }
    });
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    const run = this.transition.then(step);
    this.transition = run.catch(() => undefined);
    return run;
  }

  private async start(): Promise<void> {
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
          } catch (e) {
            this.logger.debug(`[HubPool:mDNS] Membership configuration notice: ${e instanceof Error ? e.message : String(e)}`);
          }
          resolve();
        });
      });
      this.logger.info(`[HubPool:mDNS] LAN discovery is on; listening on ${MDNS_MULTICAST_IPV4}:${MDNS_PORT}`);

      this.announce();
      this.broadcastTimer = setInterval(() => {
        this.announce();
        this.pruneStalePeers();
      }, MDNS_ANNOUNCE_INTERVAL_MS);
    } catch (error) {
      // LAN discovery is a convenience; the Hub is fully usable without it (peers can still be
      // paired over the tailnet or by address), so say so once and carry on rather than fail boot.
      // The setting stays on, so the next write to it retries.
      this.logger.warn(
        `[HubPool:mDNS] Could not start on UDP port ${MDNS_PORT}; LAN peer discovery is disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.stop();
    }
  }

  private async stop(): Promise<void> {
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
    // What was heard while on is not carried across an off: a row must not outlive the setting that
    // allowed it to be collected.
    this.discovered.clear();
    this.lastMulticastAt.clear();
  }

  /**
   * Multicast this node's records for the given service types (both, by default).
   *
   * The TXT record is deliberately thin — `txtvers`, `isCiHub`, `poolProtocol` — the same two facts
   * the unauthenticated `GET /identify` answers. The host name is in the SRV target already, and the
   * MagicDNS name is not published here at all (see the class comment).
   */
  announce(serviceTypes: readonly string[] = CIHUB_SERVICE_TYPES): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      const port = Number(process.env.API_PORT ?? process.env.BACKEND_PORT ?? process.env.PORT ?? 5002);
      const host = os.hostname().replace(/\.local$/, '');
      const lanIps = this.getLocalLanIpv4Addresses();
      if (lanIps.length === 0) return;

      const txtRecord = {
        txtvers: '1',
        isCiHub: 'true',
        poolProtocol: String(POOL_PROTOCOL_VERSION),
      };

      const now = Date.now();
      for (const serviceType of serviceTypes) {
        this.lastMulticastAt.set(serviceType, now);
        for (const ip of lanIps) {
          const packet = buildMdnsAnnouncement(serviceType, host, port, ip, txtRecord);
          socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_IPV4);
        }
      }
    } catch (err) {
      this.logger.debug(`[HubPool:mDNS] Broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query the LAN for all active `_cihub._tcp` peers.
   */
  scan(): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      for (const serviceType of CIHUB_SERVICE_TYPES) {
        const query = buildMdnsQuery(serviceType);
        socket.send(query, 0, query.length, MDNS_PORT, MDNS_MULTICAST_IPV4);
      }
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
   * The Hubs heard on the LAN, as unverified candidate rows. Empty whenever the socket is closed.
   *
   * Each row is named `<label>.local` — the mDNS host name it claimed, which no tailnet hands out, so
   * it can never fold into an attested row — and addressed by the datagram's real sender. Both are
   * for the operator to read; neither is something to dial with a pairing token.
   *
   * `knownPeersFqdn` holds the normalized names of paired peers. An mDNS row can only be compared to
   * them by host label, and a match hides the mDNS row — never anything else, so a sender that claims
   * a paired peer's label can only hide itself.
   */
  getDiscoverableCandidates(knownPeersFqdn: Set<string>): DiscoverablePoolPeer[] {
    if (!this.socket) return [];

    const selfIps = new Set(this.getLocalLanIpv4Addresses());
    const selfHost = os
      .hostname()
      .toLowerCase()
      .replace(/\.local$/, '');
    const knownHosts = new Set([...knownPeersFqdn].map(hostLabelOf));

    const candidates: DiscoverablePoolPeer[] = [];
    for (const peer of this.listDiscoveredPeers()) {
      // Our own announcements come back through multicast loopback, from one of our own addresses.
      if (selfIps.has(peer.ip) || peer.hostname === selfHost) continue;
      if (knownHosts.has(peer.hostname)) continue;

      candidates.push({
        tailscaleDeviceId: '',
        nodeFqdn: `${peer.hostname}.local`,
        hostname: peer.hostname,
        source: 'mdns',
        verified: false,
        address: `${peer.ip}:${peer.port}`,
      });
    }

    return candidates;
  }

  private handleIncomingPacket(buffer: Buffer, senderAddress: string): void {
    // A datagram already queued when the socket closed must not repopulate what stop() cleared.
    if (!this.socket) return;
    try {
      const parsed = parseMdnsPacket(buffer);
      if (!parsed) return;

      if (parsed.isResponse) {
        this.recordAnnouncement(parsed, senderAddress);
      } else {
        this.answerQuestions(parsed.questions);
      }
    } catch {
      // Ignore packet parse failures
    }
  }

  /**
   * Answer a PTR (or ANY) query for either of this Hub's service types with the same record set as
   * the periodic announcement. Without this a browser only ever learns of the Hub from the 30 s
   * beacon, so the desktop app's 3 s `find_hubs` browse missed it roughly nine times in ten.
   *
   * Always answered by multicast, the ordinary response to a standard query (RFC 6762 §6); a QU
   * question's preference for a unicast reply is not honoured, which costs the querier nothing but a
   * wider audience for records this Hub multicasts every 30 s anyway. At most once a second per
   * service type ({@link MDNS_MIN_MULTICAST_INTERVAL_MS}). Only reachable while the socket is open, so
   * the setting gates this exactly as it gates the announcement.
   */
  private answerQuestions(questions: readonly MdnsQuestion[]): void {
    if (!this.socket || questions.length === 0) return;

    const now = Date.now();
    const due = CIHUB_SERVICE_TYPES.filter(
      (serviceType) =>
        questions.some((question) => (question.type === DNS_TYPE_PTR || question.type === DNS_TYPE_ANY) && sameDnsName(question.name, serviceType)) &&
        now - (this.lastMulticastAt.get(serviceType) ?? Number.NEGATIVE_INFINITY) >= MDNS_MIN_MULTICAST_INTERVAL_MS,
    );
    if (due.length > 0) {
      this.announce(due);
    }
  }

  /**
   * Remember a Hub announcement. Responses only (QR=1): the answers a querier attaches to a query
   * are records it already holds (RFC 6762 §7.1 known-answer lists), not an announcement from it.
   */
  private recordAnnouncement(parsed: ParsedMdnsPacket, senderAddress: string): void {
    const isCihubService = parsed.services.some((s) => s.includes('_cihub._tcp') || s.includes('_ci-hub._tcp'));
    if (!isCihubService && !parsed.txt.isCiHub) return;

    const hostname = claimedHostLabel(parsed);
    if (!hostname) return;

    const port = parsed.port || 5002;
    // Keyed on the real sender, so one box cannot fill the cache by claiming many A records.
    const key = `${senderAddress}:${port}`;
    const now = Date.now();
    const claimedProtocol = parsed.txt.poolProtocol;

    this.makeRoomFor(key, now);
    this.discovered.set(key, {
      hostname,
      ip: senderAddress,
      port,
      poolProtocol: claimedProtocol && /^\d{1,3}$/.test(claimedProtocol) ? Number(claimedProtocol) : null,
      lastSeenAt: now,
    });
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

/** The first label of a host or FQDN, lowercased — the only thing an mDNS row and a tailnet name share. */
export function hostLabelOf(name: string): string {
  return (name.split('.')[0] ?? '').toLowerCase();
}

/**
 * The host label an announcement claims: its SRV target's (or, for a record set without SRV, its
 * instance name's) first label, falling back to a `hostname` TXT key from a build that still sent
 * one. `null` for anything that is not a single legal DNS label, which drops the announcement.
 */
function claimedHostLabel(parsed: ParsedMdnsPacket): string | null {
  const raw = parsed.srvTarget?.split('.')[0] || parsed.hostname;
  const label = raw?.toLowerCase();
  return label && MDNS_HOST_LABEL.test(label) ? label : null;
}

function sameDnsName(a: string, b: string): boolean {
  return a.replace(/\.$/, '').toLowerCase() === b.replace(/\.$/, '').toLowerCase();
}

// ── DNS Packet Encoding and Decoding Helpers ──

const DNS_TYPE_PTR = 12;
const DNS_TYPE_ANY = 255;
const DNS_CLASS_IN = 0x0001;
/**
 * RFC 6762 §10.2 cache-flush bit, the top bit of a record's class: "discard what you cached for this
 * name and type". Only for unique records (SRV, TXT, A here). A PTR for a service type is shared —
 * every Hub on the LAN answers for `_cihub._tcp.local` — so setting it there tells every listener to
 * forget every other Hub each time one announces.
 */
const DNS_CACHE_FLUSH = 0x8000;
const DNS_FLAG_QR_RESPONSE = 0x8000;

export interface MdnsQuestion {
  name: string;
  type: number;
}

export interface ParsedMdnsPacket {
  /** QR bit: a response (announcement or answer) rather than a query. */
  isResponse: boolean;
  questions: MdnsQuestion[];
  services: string[];
  hostname: string | null;
  srvTarget: string | null;
  port: number | null;
  /**
   * The A record's address, as the sender wrote it. Parsed for completeness and never trusted: the
   * service records the datagram's real sender instead (see `DiscoveredMdnsPeer.ip`).
   */
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
  qTypeAndClass.writeUInt16BE(DNS_TYPE_PTR, 0);
  qTypeAndClass.writeUInt16BE(DNS_CLASS_IN, 2);

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
  ptrMeta.writeUInt16BE(DNS_TYPE_PTR, 0);
  // Shared record: class IN with the cache-flush bit CLEAR (see DNS_CACHE_FLUSH).
  ptrMeta.writeUInt16BE(DNS_CLASS_IN, 2);
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
  srvMeta.writeUInt16BE(DNS_CACHE_FLUSH | DNS_CLASS_IN, 2); // unique to this Hub
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
  txtMeta.writeUInt16BE(DNS_CACHE_FLUSH | DNS_CLASS_IN, 2); // unique to this Hub
  txtMeta.writeUInt32BE(120, 4); // TTL
  txtMeta.writeUInt16BE(txtData.length, 8);
  const txtFullRecord = Buffer.concat([txtName, txtMeta, txtData]);

  // 4. A Record: targetHost -> ip
  const aName = encodeDnsName(targetHost);
  const ipParts = ip.split('.').map(Number);
  const aData = Buffer.from(ipParts);
  const aMeta = Buffer.alloc(10);
  aMeta.writeUInt16BE(1, 0); // Type A
  aMeta.writeUInt16BE(DNS_CACHE_FLUSH | DNS_CLASS_IN, 2); // unique to this Hub
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
  const flags = buffer.readUInt16BE(2);
  const qdCount = buffer.readUInt16BE(4);
  const anCount = buffer.readUInt16BE(6);

  const pointerBudget: DnsPointerBudget = { remaining: MAX_DNS_POINTER_HOPS };
  let offset = 12;

  // Questions: the name and type are kept (a query is answered by them); the class is skipped.
  const questions: MdnsQuestion[] = [];
  for (let i = 0; i < qdCount; i++) {
    const decoded = decodeDnsName(buffer, offset, pointerBudget);
    offset = decoded.nextOffset + 4; // type (2) and class (2)
    if (offset > buffer.length) throw new MalformedDnsPacketError('question runs past the end of the packet');
    questions.push({ name: decoded.name, type: buffer.readUInt16BE(decoded.nextOffset) });
  }

  const result: ParsedMdnsPacket = {
    isResponse: (flags & DNS_FLAG_QR_RESPONSE) !== 0,
    questions,
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

    if (rType === DNS_TYPE_PTR) {
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
