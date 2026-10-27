/**
 * OOBI (Out-Of-Band Introduction) generation and resolution for KERI.
 * Enables direct peer-to-peer discovery of Hubs, Witnesses, and Companion Memories
 * over LAN, Tailscale MagicDNS, or HTTPS without relying on CI-Portal.
 */

export interface OobiMetadata {
  aid: string;
  role?: 'hub' | 'witness' | 'peer' | 'watcher';
  name?: string;
  endpoints: string[];
}

/** Builds a standard OOBI URL for an endpoint and AID. */
export function buildOobiUrl(params: { endpoint: string; aid: string; role?: 'hub' | 'witness' | 'peer' | 'watcher'; name?: string }): string {
  const url = new URL(`/.well-known/keri/oobi/${encodeURIComponent(params.aid)}`, params.endpoint);
  if (params.role) {
    url.searchParams.set('role', params.role);
  }
  if (params.name) {
    url.searchParams.set('name', params.name);
  }
  return url.toString();
}

/** Parses an OOBI URL into its constituent metadata. */
export function parseOobiUrl(oobiUrl: string): OobiMetadata {
  const url = new URL(oobiUrl);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const oobiIndex = pathParts.indexOf('oobi');

  if (oobiIndex === -1 || oobiIndex === pathParts.length - 1) {
    throw new Error(`Invalid OOBI URL format: missing /oobi/<aid> path in ${oobiUrl}`);
  }

  const aid = decodeURIComponent(pathParts[oobiIndex + 1]);
  const role = url.searchParams.get('role') as OobiMetadata['role'] | undefined;
  const name = url.searchParams.get('name') ?? undefined;

  // Extract base endpoint (origin)
  const endpoint = url.origin;

  return {
    aid,
    role: role || undefined,
    name,
    endpoints: [endpoint],
  };
}

export interface OobiDiscoveryPayload {
  aid: string;
  role: string;
  urls: string[];
  currentKey: string;
  kelDigest: string;
  witnesses?: string[];
}

/** Formats the JSON payload returned by GET /.well-known/keri/oobi */
export function createOobiDiscoveryResponse(params: {
  aid: string;
  role: string;
  urls: string[];
  currentPublicKey: string;
  latestKelDigest: string;
  witnesses?: string[];
}): OobiDiscoveryPayload {
  return {
    aid: params.aid,
    role: params.role,
    urls: params.urls,
    currentKey: params.currentPublicKey,
    kelDigest: params.latestKelDigest,
    witnesses: params.witnesses ?? [],
  };
}
