import dns, { type LookupAddress, promises as dnsPromises } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { withTimeout } from '@/common/helpers/with-timeout';

/**
 * Does the Hub answer at its public URL, and which resolver said where that URL is?
 *
 * The question behind `publicly_ready` is whether the internet reaches this Hub, and the only honest
 * answer is a 2xx over TLS that is valid for the name. What this host's own resolver thinks is a
 * separate question, and after a device is released and paired again the two disagree for a while.
 *
 * Inside the Hub container a name is resolved by getaddrinfo against Docker's embedded DNS
 * (127.0.0.11), which forwards from the host's network namespace to the host's resolver
 * (`ExtServers: [host(127.0.0.53)]`, systemd-resolved on the fleet), which forwards to the LAN's
 * upstream. Every hop after the first caches a negative answer for the zone's SOA minimum: 1800 s
 * for ci.computer. A release deletes the Hub's hostname, the old Hub or anything else asks for it,
 * and when Portal creates the same name again minutes later this host goes on saying NXDOMAIN for
 * up to half an hour, far past the one minute registration spends probing. After the 2026-09-26
 * fleet rebuild, 16 of 17 Hubs came out of registration `locally_ready`.
 *
 * So the probe asks the zone's own nameservers first, which hold no cache. A name they do not
 * publish is not ready, and this host's resolver is never asked about it: asking is what plants
 * the NXDOMAIN, in systemd-resolved and in the LAN resolver every browser on that network shares.
 * Once they publish it, the request goes through this host's resolver, and only if that still has
 * no address does it go to the address the zone publishes, with the certificate still checked
 * against the name. Any other failure (a timeout, a TLS error, Cloudflare's 530 for a tunnel with
 * no connector) is not about DNS, and is the answer.
 */

/** The liveness route: it answers without RabbitMQ or any other dependency, so a 2xx means the request reached this Hub. */
export const PUBLIC_PROBE_PATH = '/api/health/live';

/** Budget for each step of a probe; a probe that goes around this host's resolver takes three. */
export const PUBLIC_PROBE_TIMEOUT_MS = 5_000;

/**
 * Codes that mean this host's resolver produced no address, as opposed to an address that did not
 * answer. `ENOTFOUND` is getaddrinfo's NXDOMAIN, `ENODATA` a name without A or AAAA records (what a
 * DNSSEC "black lie" looks like), and `EAI_AGAIN` a resolver that did not answer at all.
 */
const NAME_NOT_RESOLVED_CODES = new Set(['ENOTFOUND', 'ENODATA', 'EAI_AGAIN']);

/** What a resolver says about a name it has no records for; any other error is a failure to ask. */
const NO_RECORDS_CODES = new Set(['ENOTFOUND', 'ENODATA']);

export type PublicReachability = {
  reachable: boolean;
  /**
   * Which resolver decided: `system` is this host's resolver chain, and `zone_nameservers` the
   * zone's authoritative servers, which decide when they do not publish the name or when the
   * request went to their address because `system` had none.
   */
  via: 'system' | 'zone_nameservers';
  /** The HTTP status that decided, when a response came back. */
  status?: number;
  /** Why no 2xx came back, or how the 2xx was reached, when there is more to say than the status. */
  detail?: string;
};

/**
 * What the zone's own nameservers say about a name.
 *
 * Only `nxdomain` means "not published". `no_address` is a name that exists there without an A or
 * AAAA record: a CNAME to a name outside the zone looks like that from an authoritative server, and
 * so does a DNSSEC "black lie" for a name that does not exist. It decides nothing, so the probe
 * asks this host's resolver, which follows the CNAME.
 */
export type ZoneAnswer = { kind: 'addresses'; addresses: string[] } | { kind: 'nxdomain' } | { kind: 'no_address' };

/** Rejects an address the probe must not connect to or send queries to. */
export type AddressFilter = (address: string) => boolean;

export type PublicProbeOptions = {
  timeoutMs?: number;
  /**
   * Count only a request this host's resolver routed. For a caller that sends a browser to the URL
   * next: the browser usually shares this host's upstream resolver and its cached NXDOMAIN, so an
   * answer that went around that cache would send it to a name it cannot resolve.
   */
  requireSystemResolver?: boolean;
  /** For a caller probing a hostname it was handed: refuse private addresses from either resolver (SSRF). */
  isAllowedAddress?: AddressFilter;
};

export type PublicReachabilityDeps = {
  /**
   * GETs `url` and resolves with its status. With `addresses`, connects there instead of resolving
   * the host; with `isAllowedAddress`, refuses a host that resolves to an address it rejects.
   */
  get(url: string, options: { addresses?: string[]; isAllowedAddress?: AddressFilter; timeoutMs: number }): Promise<number>;
  /** What the zone's own nameservers publish for `hostname`. */
  resolveAtZoneNameservers(hostname: string, options: { timeoutMs: number; isAllowedAddress?: AddressFilter }): Promise<ZoneAnswer>;
};

/** Probes `https://<hostname>/api/health/live`, asking the zone's nameservers before this host's resolver. */
export async function probePublicHostname(
  hostname: string,
  options: PublicProbeOptions = {},
  deps: PublicReachabilityDeps = defaultPublicReachabilityDeps,
): Promise<PublicReachability> {
  const timeoutMs = options.timeoutMs ?? PUBLIC_PROBE_TIMEOUT_MS;
  const { isAllowedAddress } = options;
  const url = `https://${hostname}${PUBLIC_PROBE_PATH}`;

  let zone: ZoneAnswer | undefined;
  let zoneError: unknown;
  try {
    zone = await withTimeout(
      deps.resolveAtZoneNameservers(hostname, { timeoutMs, ...(isAllowedAddress ? { isAllowedAddress } : {}) }),
      timeoutMs,
      `the zone's nameservers did not answer within ${timeoutMs} ms`,
    );
  } catch (error) {
    // A network that blocks DNS to arbitrary servers ends up here on every probe. This host's
    // resolver is then the only one there is, so ask it, as the probe did before the zone came first.
    zoneError = error;
  }

  if (zone?.kind === 'nxdomain') {
    return { reachable: false, via: 'zone_nameservers', detail: "the zone's nameservers do not publish it yet" };
  }
  const refused = zone?.kind === 'addresses' && isAllowedAddress ? zone.addresses.find((address) => !isAllowedAddress(address)) : undefined;
  if (refused) {
    return { reachable: false, via: 'zone_nameservers', detail: `the zone's nameservers publish ${refused}, which this probe may not connect to` };
  }

  let systemMiss: string;
  try {
    return verdict(await deps.get(url, { timeoutMs, ...(isAllowedAddress ? { isAllowedAddress } : {}) }), 'system');
  } catch (error) {
    if (!isNameNotResolved(error)) {
      return { reachable: false, via: 'system', detail: describeProbeError(error, timeoutMs) };
    }
    systemMiss = `this host's resolver has no address for it (${describeProbeError(error, timeoutMs)}), which a cached NXDOMAIN keeps for up to the zone's negative TTL`;
  }

  if (zone?.kind !== 'addresses') {
    const zoneSays = zoneError
      ? `the zone's nameservers could not be asked: ${describeProbeError(zoneError, timeoutMs)}`
      : "the zone's nameservers publish no address for it";
    return { reachable: false, via: 'system', detail: `${systemMiss}, and ${zoneSays}` };
  }
  if (options.requireSystemResolver) {
    return { reachable: false, via: 'system', detail: `${systemMiss}, though the zone's nameservers publish it` };
  }

  try {
    return { ...verdict(await deps.get(url, { addresses: zone.addresses, timeoutMs }), 'zone_nameservers'), detail: systemMiss };
  } catch (error) {
    return { reachable: false, via: 'zone_nameservers', detail: `${systemMiss}; ${describeProbeError(error, timeoutMs)}` };
  }
}

/** One line for a log: which resolver decided, and what came back. */
export function describePublicReachability(probe: PublicReachability): string {
  const path = probe.via === 'system' ? "through this host's resolver" : "through the zone's nameservers";
  const outcome = probe.status === undefined ? undefined : `HTTP ${probe.status}`;
  return [path, probe.detail, outcome].filter(Boolean).join('; ');
}

function verdict(status: number, via: PublicReachability['via']): PublicReachability {
  // Only a 2xx. The liveness route answers 200, so a redirect or an error means the request did not
  // reach a working Hub: Cloudflare's 530 for a tunnel with no connector proves only that the edge is up.
  return { reachable: status >= 200 && status < 300, via, status };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isNameNotResolved(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && NAME_NOT_RESOLVED_CODES.has(code);
}

function describeProbeError(error: unknown, timeoutMs: number): string {
  if ((error as { name?: unknown } | null)?.name === 'AbortError' || errorCode(error) === 'ABORT_ERR') {
    return `no response within ${timeoutMs} ms`;
  }
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

/**
 * A `lookup` that answers with `addresses` whatever it is asked.
 *
 * `net.connect` asks with `all: true` when it races address families (Node's default since 20)
 * and for a single address otherwise, and the two callbacks have different shapes.
 */
export function pinnedLookup(addresses: string[]): net.LookupFunction {
  const entries: LookupAddress[] = addresses.map((address) => ({ address, family: net.isIP(address) === 6 ? 6 : 4 }));
  return (hostname, options, callback) => {
    const [first] = entries;
    if (!first) {
      callback(Object.assign(new Error(`no pinned address for ${hostname}`), { code: 'ENOTFOUND' }), '');
      return;
    }
    if (options.all) {
      callback(null, entries);
      return;
    }
    callback(null, first.address, first.family);
  };
}

/**
 * This host's `lookup`, refusing a name that resolves to any address `isAllowedAddress` rejects.
 *
 * The check runs on the addresses the socket then connects to, so a name cannot pass it and
 * resolve somewhere else a moment later.
 */
export function allowedAddressLookup(isAllowedAddress: AddressFilter): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { family: options.family, hints: options.hints, all: true }, (error, entries) => {
      if (error) {
        callback(error, '');
        return;
      }
      const refused = entries.find((entry) => !isAllowedAddress(entry.address));
      if (refused) {
        callback(new Error(`${hostname} resolves to ${refused.address}, which this probe may not connect to`), '');
        return;
      }
      pinnedLookup(entries.map((entry) => entry.address))(hostname, options, callback);
    });
  };
}

type HttpsGetOptions = { addresses?: string[]; isAllowedAddress?: AddressFilter; timeoutMs: number };

/**
 * How much of a response the app probe keeps. Cloudflare puts the Ray ID and the error number near
 * the top of its error page, and that is all the availability check reads. The rest of an app's
 * document is not part of the verdict.
 */
const RESPONSE_EXCERPT_BYTES = 64 * 1024;

/**
 * Opens `url` over HTTPS.
 *
 * With `addresses`, the connection goes there while the Host header, SNI, and certificate check all
 * keep the URL's name, so a pinned request proves exactly what an unpinned one would.
 */
function openHttpsGet(url: string, options: HttpsGetOptions, onResponse: (response: IncomingMessage) => void) {
  const lookup = options.addresses?.length
    ? pinnedLookup(options.addresses)
    : options.isAllowedAddress
      ? allowedAddressLookup(options.isAllowedAddress)
      : undefined;
  return https.get(
    url,
    {
      // A fresh connection every time: a pooled socket answers for whichever address it was opened to.
      agent: false,
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { 'user-agent': 'ci-hub-public-reachability' },
      ...(lookup ? { lookup } : {}),
    },
    onResponse,
  );
}

/**
 * GETs `url` over HTTPS and resolves with the status, without reading the body.
 *
 * With `addresses`, the connection goes there while the Host header, SNI, and certificate check all
 * keep the URL's name, so a pinned request proves exactly what an unpinned one would.
 */
export function httpsGetStatus(url: string, options: HttpsGetOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = openHttpsGet(url, options, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
  });
}

/**
 * GETs `url` and keeps the status plus the start of the body.
 *
 * The app availability check tells a Cloudflare error page from the app itself by the page text, so
 * a status alone is not enough. The pin is the same one {@link httpsGetStatus} uses.
 */
export function httpsGetExcerpt(url: string, options: HttpsGetOptions): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (status: number, text: string) => {
      if (settled) return;
      settled = true;
      resolve({ status, text });
    };
    const request = openHttpsGet(url, options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      // Destroying the socket once the excerpt is full raises an error. That stop is the point.
      let capped = false;
      const done = () => finish(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'));
      response.on('data', (chunk: Buffer | string) => {
        if (size >= RESPONSE_EXCERPT_BYTES) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const room = RESPONSE_EXCERPT_BYTES - size;
        chunks.push(buf.subarray(0, room));
        size += Math.min(buf.length, room);
        if (size >= RESPONSE_EXCERPT_BYTES) {
          capped = true;
          response.destroy();
        }
      });
      response.on('end', done);
      response.on('close', done);
      response.on('error', (error) => {
        if (capped) {
          done();
          return;
        }
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

type ZoneResolver = Pick<dnsPromises.Resolver, 'resolveNs' | 'resolve4' | 'resolve6' | 'setServers'>;

type AskResult = { addresses: string[] } | { code: string } | { error: unknown };

async function ask(query: Promise<string[]>): Promise<AskResult> {
  try {
    return { addresses: await query };
  } catch (error) {
    const code = errorCode(error);
    return code !== undefined && NO_RECORDS_CODES.has(code) ? { code } : { error };
  }
}

/**
 * What the zone's authoritative nameservers publish for `hostname`.
 *
 * The zone is found by walking up from the name's parent until a name has NS records, which this
 * host's resolver answers from a positive cache: the zone existed all along, only the one name did
 * not. Both address families, IPv4 first, for the nameservers and for the name: a container network
 * commonly has no IPv6 route even where the zone publishes AAAA, and an IPv6-only host has no IPv4
 * one. `createResolver` is for tests; each call must return a fresh resolver.
 */
export async function resolveAtZoneNameservers(
  hostname: string,
  options: { timeoutMs: number; isAllowedAddress?: AddressFilter; createResolver?: () => ZoneResolver },
): Promise<ZoneAnswer> {
  const createResolver = options.createResolver ?? (() => new dnsPromises.Resolver({ timeout: options.timeoutMs, tries: 1 }));
  const local = createResolver();
  const nameservers = await findZoneNameservers(local, hostname);
  const addressesOf = async (family: 'resolve4' | 'resolve6') =>
    (await Promise.all(nameservers.map((ns) => local[family](ns).catch((): string[] => [])))).flat();
  const [v4, v6] = await Promise.all([addressesOf('resolve4'), addressesOf('resolve6')]);
  // A hostname someone else chose can name its own nameservers, so they get the same address check as the request.
  const serverAddresses = [...new Set([...v4, ...v6])].filter((address) => options.isAllowedAddress?.(address) ?? true);
  if (serverAddresses.length === 0) {
    throw new Error(`no usable address for the zone's nameservers (${nameservers.join(', ')})`);
  }

  const authoritative = createResolver();
  authoritative.setServers(serverAddresses);
  const answers = await Promise.all([ask(authoritative.resolve4(hostname)), ask(authoritative.resolve6(hostname))]);

  const addresses = answers.flatMap((answer) => ('addresses' in answer ? answer.addresses : []));
  if (addresses.length > 0) {
    return { kind: 'addresses', addresses };
  }
  // NXDOMAIN is about the name, not a record type, so one family saying it is enough.
  if (answers.some((answer) => 'code' in answer && answer.code === 'ENOTFOUND')) {
    return { kind: 'nxdomain' };
  }
  const failed = answers.find((answer): answer is { error: unknown } => 'error' in answer);
  if (failed) {
    throw failed.error;
  }
  return { kind: 'no_address' };
}

async function findZoneNameservers(resolver: ZoneResolver, hostname: string): Promise<string[]> {
  const labels = hostname.split('.');
  // From the parent: a Hub's name is a record in the Portal's zone, not a zone of its own. Stop above the TLD.
  for (let i = 1; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const nameservers = await resolver.resolveNs(candidate).catch(noRecords);
    if (nameservers.length > 0) {
      return nameservers;
    }
  }
  throw new Error(`no zone with nameservers above ${hostname}`);
}

function noRecords(error: unknown): string[] {
  const code = errorCode(error);
  if (code !== undefined && NO_RECORDS_CODES.has(code)) {
    return [];
  }
  throw error;
}

const defaultPublicReachabilityDeps: PublicReachabilityDeps = {
  get: httpsGetStatus,
  resolveAtZoneNameservers: (hostname, options) => resolveAtZoneNameservers(hostname, options),
};
