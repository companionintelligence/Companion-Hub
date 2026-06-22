import { sanitizeAppSubdomain } from '../public-web/identity.js';

export interface TailscaleWebIdentity {
  appSubdomain: string;
  nodeFqdn: string;
  hostname: string;
  url: string;
  mode: 'service' | 'path';
}

export interface BuildTailscaleWebIdentityInput {
  appSubdomain: string;
  nodeFqdn?: string | null;
  hostname?: string | null;
  tailnet?: string | null;
  supportsServices?: boolean;
}

export interface BuildTailscalePortUrlInput {
  nodeFqdn?: string | null;
  port?: number | null;
  pathSuffix?: string;
}

export function buildTailscaleNodeFqdn(hostname?: string | null, tailnet?: string | null): string | null {
  const cleanHostname = hostname?.trim();
  const cleanTailnet = tailnet?.trim();

  if (!cleanHostname || !cleanTailnet) {
    return null;
  }

  if (cleanHostname === cleanTailnet || cleanHostname.endsWith(`.${cleanTailnet}`)) {
    return cleanHostname;
  }

  return `${cleanHostname}.${cleanTailnet}`;
}

export function buildTailscaleWebIdentity(input: BuildTailscaleWebIdentityInput): TailscaleWebIdentity | null {
  const appSubdomain = sanitizeAppSubdomain(input.appSubdomain);
  const nodeFqdn = input.nodeFqdn?.trim() || buildTailscaleNodeFqdn(input.hostname, input.tailnet);

  if (!appSubdomain || !nodeFqdn) {
    return null;
  }

  if (input.supportsServices) {
    const hostname = `${appSubdomain}.${nodeFqdn}`;
    return {
      appSubdomain,
      nodeFqdn,
      hostname,
      url: `https://${hostname}`,
      mode: 'service',
    };
  }

  return {
    appSubdomain,
    nodeFqdn,
    hostname: nodeFqdn,
    url: `https://${nodeFqdn}/${appSubdomain}`,
    mode: 'path',
  };
}

export function buildTailscalePortHost(nodeFqdn?: string | null, port?: number | null): string | null {
  const cleanNodeFqdn = nodeFqdn?.trim();
  if (!cleanNodeFqdn || !port) {
    return null;
  }

  return `${cleanNodeFqdn}:${port}`;
}

export function buildTailscalePortUrl(input: BuildTailscalePortUrlInput): string | null {
  const host = buildTailscalePortHost(input.nodeFqdn, input.port);
  if (!host) {
    return null;
  }

  return `https://${host}${input.pathSuffix || ''}`;
}
