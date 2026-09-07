import { isIP } from 'node:net';

/**
 * Manual peer entry: parsing and port selection for an operator-typed address.
 *
 * Deliberately a separate module from `@/common/helpers/hub-pool`, whose `normalizePeerFqdn` exists
 * to *reject* exactly these shapes. An address is legal in precisely two places — the
 * operator-authenticated probe, and the PIN-gated pairing request that probe leads to — and it is
 * discarded as soon as the far side has answered with its tailnet name. Keeping the two vocabularies
 * in separate files is what stops an address ever being mistaken for a stored peer name.
 *
 * There is deliberately no candidate cache here any more, and so no miss threshold and no ceiling on
 * remembered entries. Those existed to age out addresses held in a *named* candidate list; since
 * `/identify` no longer discloses a name, an address never becomes a named candidate at all, and a
 * cache of unnamed ones would be a second identity space next to `node_fqdn`.
 */

/** Longest address string accepted, so a pathological input never reaches the parser's regexes. */
const MAX_PROBE_INPUT_LENGTH = 300;

/** One DNS label, matching the `HOSTNAME_LABEL` rule used for stored peer FQDNs. */
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface PoolProbeTarget {
  /** A bare IPv4/IPv6 literal or a DNS name. Never a URL, never carries a port, never bracketed. */
  host: string;
  /** The port the operator typed explicitly, or `null` to fall back to {@link poolProbePortCandidates}. */
  port: number | null;
  /** True when {@link host} is an IPv6 literal, so a caller knows to bracket it when building a URL. */
  isIpv6: boolean;
}

/**
 * Parses `host`, `host:port`, an IPv4 literal, or a bracketed IPv6 literal. A leading `http://` or
 * `https://` is tolerated and stripped, because that is what an operator copies out of a browser.
 *
 * Returns `null` for anything carrying a path, query, fragment or credentials — those are the shapes
 * that make an address ambiguous with a URL, and this value goes on to build one.
 */
export function parseProbeTarget(raw: string): PoolProbeTarget | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_PROBE_INPUT_LENGTH) {
    return null;
  }

  const withoutScheme = trimmed.replace(/^https?:\/\//, '');
  // A trailing slash is the one piece of URL punctuation worth forgiving; anything else means the
  // operator pasted something that is not an address.
  const candidate = withoutScheme.replace(/\/$/, '');
  if (!candidate || /[/?#@\s\\]/.test(candidate)) {
    return null;
  }

  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(candidate);
  if (bracketed) {
    const host = bracketed[1] as string;
    if (isIP(host) !== 6) return null;
    const port = parsePort(bracketed[2]);
    return port === undefined ? null : { host, port, isIpv6: true };
  }

  // A bare IPv6 literal has more than one colon, so it can never be split as `host:port`.
  if (isIP(candidate) === 6) {
    return { host: candidate, port: null, isIpv6: true };
  }

  const lastColon = candidate.lastIndexOf(':');
  const host = lastColon === -1 ? candidate : candidate.slice(0, lastColon);
  const port = lastColon === -1 ? null : parsePort(candidate.slice(lastColon + 1));
  if (port === undefined || !host) {
    return null;
  }

  if (isIP(host) === 4) {
    return { host, port, isIpv6: false };
  }
  // A DNS name. Single-label names are allowed — `mini-pc:5002` is a normal thing to type on a LAN
  // with a local resolver — but every label still has to be a legal one.
  const labels = host.split('.');
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) {
    return null;
  }
  return { host, port, isIpv6: false };
}

/** `undefined` = present but invalid (reject the whole input); `null` = absent. */
function parsePort(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return null;
  if (!/^\d{1,5}$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Ports to try, in order, when the operator did not type one.
 *
 * `API_PORT` inside the backend container is NOT the port the Hub is published on: every compose
 * file sets `API_PORT: 5002` in the service's own `environment:` block while publishing
 * `${API_PORT:-5002}:5002` on the host. So the env var is a hint, not an answer, and an operator who
 * moved the published port has to type it. Trying a short ordered list rather than guessing once is
 * what keeps that from being a silent "not a CI-Hub" verdict; the error names the fix.
 */
export function poolProbePortCandidates(explicitPort: number | null, env: NodeJS.ProcessEnv = process.env): number[] {
  if (explicitPort !== null) {
    return [explicitPort];
  }
  const fromEnv = Number(env.API_PORT);
  const ordered = [Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 65535 ? fromEnv : null, 5002, 3000];
  return [...new Set(ordered.filter((port): port is number => port !== null))];
}

/** `host:port` with IPv6 bracketed — the authority half of the probe URL. */
export function formatProbeAuthority(target: PoolProbeTarget, port: number): string {
  return target.isIpv6 ? `[${target.host}]:${port}` : `${target.host}:${port}`;
}
