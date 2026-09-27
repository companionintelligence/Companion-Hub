import { type LookupAddress, promises as dnsPromises } from 'node:dns';
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
 * So when this host's resolver has no address for the name, and only then, the probe asks the
 * zone's own nameservers, which hold no cache, and requests the URL at the address they publish
 * with the certificate still checked against the name. Any other failure (a timeout, a TLS error,
 * Cloudflare's 530 for a tunnel with no connector) is not about DNS, and is the answer.
 */

/** The liveness route: it answers without RabbitMQ or any other dependency, so a 2xx means the request reached this Hub. */
export const PUBLIC_PROBE_PATH = '/api/health/live';

/** Budget for each step of a probe; a probe that asks the zone's nameservers takes three. */
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
   * Whose addresses the deciding request went to: `system` is this host's resolver chain, and
   * `zone_nameservers` the zone's authoritative servers, asked only after `system` had no address.
   */
  via: 'system' | 'zone_nameservers';
  /** The HTTP status that decided, when a response came back. */
  status?: number;
  /** Why no 2xx came back, when there is more to say than the status. */
  detail?: string;
};

export type PublicReachabilityDeps = {
  /** GETs `url` and resolves with its status. With `addresses`, connects there instead of resolving the host. */
  get(url: string, options: { addresses?: string[]; timeoutMs: number }): Promise<number>;
  /** The addresses the zone's own nameservers publish for `hostname`; empty when they publish none. */
  resolveAtZoneNameservers(hostname: string, timeoutMs: number): Promise<string[]>;
};

/** Probes `https://<hostname>/api/health/live`, asking the zone's nameservers when this host cannot resolve the name. */
export async function probePublicHostname(
  hostname: string,
  options: { timeoutMs?: number } = {},
  deps: PublicReachabilityDeps = defaultPublicReachabilityDeps,
): Promise<PublicReachability> {
  const timeoutMs = options.timeoutMs ?? PUBLIC_PROBE_TIMEOUT_MS;
  const url = `https://${hostname}${PUBLIC_PROBE_PATH}`;

  let systemError: unknown;
  try {
    return verdict(await deps.get(url, { timeoutMs }), 'system');
  } catch (error) {
    if (!isNameNotResolved(error)) {
      return { reachable: false, via: 'system', detail: describeProbeError(error, timeoutMs) };
    }
    systemError = error;
  }

  let addresses: string[];
  try {
    addresses = await withTimeout(
      deps.resolveAtZoneNameservers(hostname, timeoutMs),
      timeoutMs,
      `the zone's nameservers did not answer within ${timeoutMs} ms`,
    );
  } catch (error) {
    return {
      reachable: false,
      via: 'zone_nameservers',
      detail: `this host has no address for it (${describeProbeError(systemError, timeoutMs)}), and the zone's nameservers could not be asked: ${describeProbeError(error, timeoutMs)}`,
    };
  }

  if (addresses.length === 0) {
    return { reachable: false, via: 'zone_nameservers', detail: "the zone's nameservers do not publish it yet" };
  }

  try {
    return verdict(await deps.get(url, { addresses, timeoutMs }), 'zone_nameservers');
  } catch (error) {
    return { reachable: false, via: 'zone_nameservers', detail: describeProbeError(error, timeoutMs) };
  }
}

/** One line for a log: which resolver decided, and what came back. */
export function describePublicReachability(probe: PublicReachability): string {
  const path =
    probe.via === 'system'
      ? "resolved by this host's resolver"
      : "this host's resolver has no address for it, which a cached NXDOMAIN keeps up to the zone's negative TTL; asked the zone's nameservers";
  const outcome = probe.status === undefined ? undefined : `HTTP ${probe.status}`;
  return [path, outcome, probe.detail].filter(Boolean).join('; ');
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
 * GETs `url` over HTTPS and resolves with the status, without reading the body.
 *
 * With `addresses`, the connection goes there while the Host header, SNI, and certificate check all
 * keep the URL's name, so a pinned request proves exactly what an unpinned one would.
 */
export function httpsGetStatus(url: string, options: { addresses?: string[]; timeoutMs: number }): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        // A fresh connection every time: a pooled socket answers for whichever address it was opened to.
        agent: false,
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { 'user-agent': 'ci-hub-public-reachability' },
        ...(options.addresses?.length ? { lookup: pinnedLookup(options.addresses) } : {}),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
  });
}

type ZoneResolver = Pick<dnsPromises.Resolver, 'resolveNs' | 'resolve4' | 'resolve6' | 'setServers'>;

/**
 * The addresses the zone's authoritative nameservers publish for `hostname`.
 *
 * The zone is found by walking up from the name's parent until a name has NS records, which this
 * host's resolver answers from a positive cache: the zone existed all along, only the one name did
 * not. IPv4 first, because a container network commonly has no IPv6 route even where the zone
 * publishes AAAA. `createResolver` is for tests; each call must return a fresh resolver.
 */
export async function resolveAtZoneNameservers(
  hostname: string,
  timeoutMs: number,
  createResolver: () => ZoneResolver = () => new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 }),
): Promise<string[]> {
  const local = createResolver();
  const nameservers = await findZoneNameservers(local, hostname);
  const serverAddresses = [...new Set((await Promise.all(nameservers.map((ns) => local.resolve4(ns).catch((): string[] => [])))).flat())];
  if (serverAddresses.length === 0) {
    throw new Error(`no address for the zone's nameservers (${nameservers.join(', ')})`);
  }

  const authoritative = createResolver();
  authoritative.setServers(serverAddresses);
  const v4 = await authoritative.resolve4(hostname).catch(noRecords);
  return v4.length > 0 ? v4 : authoritative.resolve6(hostname).catch(noRecords);
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
  resolveAtZoneNameservers: (hostname, timeoutMs) => resolveAtZoneNameservers(hostname, timeoutMs),
};
