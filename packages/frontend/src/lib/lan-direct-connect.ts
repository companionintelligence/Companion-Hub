/**
 * Hybrid LAN Direct Connect.
 *
 * Probes a local Hub IP address over LAN before falling back to remote tunnel.
 * When on the same local network as the Hub appliance, connecting directly over
 * LAN eliminates internet round-trip latency, bandwidth limits, and cloud tunnel dependencies.
 */

import { runtimeFetch, type FetchLike } from './runtime-fetch';

export const DEFAULT_LAN_PORT = 5002;
export const DEFAULT_LAN_PROBE_TIMEOUT_MS = 1500;
export const DEFAULT_LAN_PROBE_PATH = '/api/health/live';

export type ConnectionTransport = 'lan' | 'tunnel';

export interface LanProbeOptions {
  /** Maximum time to wait for LAN probe in ms before declaring unreachable (default: 1500ms). */
  timeoutMs?: number;
  /** Endpoint path to probe on the candidate LAN Hub (default: "/api/health/live"). */
  probePath?: string;
  /** Fetch implementation to use (defaults to runtimeFetch). */
  fetchFn?: FetchLike;
}

export interface LanDirectConnectOptions {
  /** Candidate LAN address (e.g. "192.168.1.50", "192.168.1.50:5002", "http://hub.local:5002"). */
  lanAddress?: string | null;
  /** Remote tunnel URL to fall back to when LAN is unreachable (e.g. "https://hub-xyz.ci.computer"). */
  remoteTunnelUrl: string;
  /** Maximum time to wait for LAN probe in ms (default: 1500ms). */
  timeoutMs?: number;
  /** Endpoint path to probe (default: "/api/health/live"). */
  probePath?: string;
  /** Fetch implementation (defaults to runtimeFetch). */
  fetchFn?: FetchLike;
  /** Default port to use if not specified in lanAddress (default: 5002). */
  defaultPort?: number;
}

export interface ResolvedHubConnection {
  /** The selected base URL to use for API requests. */
  baseUrl: string;
  /** Whether the connection resolved to the local LAN or the remote tunnel. */
  transport: ConnectionTransport;
  /** The normalized candidate LAN base URL (or null if none was provided). */
  lanCandidateUrl: string | null;
  /** The normalized remote tunnel URL. */
  remoteTunnelUrl: string;
  /** Whether a probe attempt was made. */
  probed: boolean;
}

/**
 * Normalizes a URL by trimming whitespace and trailing slashes.
 */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Normalizes a candidate LAN address/host into a well-formed base URL.
 * Examples:
 *  - "192.168.1.50" -> "http://192.168.1.50:5002"
 *  - "192.168.1.50:5004" -> "http://192.168.1.50:5004"
 *  - "http://192.168.1.50:5002/" -> "http://192.168.1.50:5002"
 *  - "https://hub.local:5002" -> "https://hub.local:5002"
 */
export function normalizeLanUrl(address?: string | null, defaultPort = DEFAULT_LAN_PORT): string | null {
  if (!address) return null;
  let trimmed = address.trim();
  if (!trimmed) return null;

  // Add default http:// scheme if missing
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }

  try {
    const parsed = new URL(trimmed);
    const port = parsed.port || String(defaultPort);
    const protocol = parsed.protocol;
    const host = parsed.hostname;
    return `${protocol}//${host}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Probes a candidate LAN Hub base URL by checking a live health endpoint.
 * Returns true if the endpoint answers with 2xx ok, false on error/timeout.
 */
export async function probeLanHub(lanBaseUrl: string, options?: LanProbeOptions): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LAN_PROBE_TIMEOUT_MS;
  const probePath = options?.probePath ?? DEFAULT_LAN_PROBE_PATH;
  const fetchFn = options?.fetchFn ?? runtimeFetch;

  const normalizedBase = normalizeUrl(lanBaseUrl);
  const normalizedPath = probePath.startsWith('/') ? probePath : `/${probePath}`;
  const targetUrl = `${normalizedBase}${normalizedPath}`;

  try {
    const res = await fetchFn(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probes a candidate LAN address before falling back to the remote tunnel.
 */
export async function resolveHubConnection(options: LanDirectConnectOptions): Promise<ResolvedHubConnection> {
  const normalizedTunnel = normalizeUrl(options.remoteTunnelUrl);
  const normalizedLan = normalizeLanUrl(options.lanAddress, options.defaultPort ?? DEFAULT_LAN_PORT);

  if (!normalizedLan) {
    return {
      baseUrl: normalizedTunnel,
      transport: 'tunnel',
      lanCandidateUrl: null,
      remoteTunnelUrl: normalizedTunnel,
      probed: false,
    };
  }

  const isReachable = await probeLanHub(normalizedLan, {
    timeoutMs: options.timeoutMs,
    probePath: options.probePath,
    fetchFn: options.fetchFn,
  });

  if (isReachable) {
    return {
      baseUrl: normalizedLan,
      transport: 'lan',
      lanCandidateUrl: normalizedLan,
      remoteTunnelUrl: normalizedTunnel,
      probed: true,
    };
  }

  return {
    baseUrl: normalizedTunnel,
    transport: 'tunnel',
    lanCandidateUrl: normalizedLan,
    remoteTunnelUrl: normalizedTunnel,
    probed: true,
  };
}

/**
 * Resolves the Hub base URL: returns LAN candidate if reachable, otherwise remote tunnel.
 */
export async function resolveHubBaseUrl(options: LanDirectConnectOptions): Promise<string> {
  const connection = await resolveHubConnection(options);
  return connection.baseUrl;
}
