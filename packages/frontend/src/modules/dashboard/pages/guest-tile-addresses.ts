import type { GuestAppsDto } from '@/api-client';
import { hasDirectLocalAccess, isLoopbackHost, resolveReachableHubHost } from '@/modules/app/components/app-access-points/app-access-points';
import { hostPortStaysOnLoopback } from '@ci-hub/common/schemas';

const LOOPBACK_HOST = '127.0.0.1';
const TAILNET_HOST_SUFFIX = '.ts.net';

export interface GuestTileAddress {
  key: 'public' | 'vpn' | 'local';
  url: string;
  label: string;
}

/**
 * The host a guest can reach an app's port on, or `null` when there is none.
 *
 * `127.0.0.1` is the guest's own computer, so it is right only for a browser on the Hub. From a LAN
 * or tailnet address, the name the browser used to reach this page is one it can reach. From the
 * public hostname nothing is: the tunnel carries 443 only.
 */
function guestPortHost(info: GuestAppsDto['installed'][number]['info'], viewerHostname: string, publicDomain: string): string | null {
  if (isLoopbackHost(viewerHostname)) {
    return LOOPBACK_HOST;
  }

  if (hostPortStaysOnLoopback(info)) {
    return null;
  }

  return resolveReachableHubHost({ viewerHostname, publicDomain }) ?? null;
}

/** What a guest's tile offers to open, best address first. */
export function guestTileAddresses(input: {
  data: GuestAppsDto['installed'][number];
  sslPort: number;
  publicDomain: string;
  viewerHostname: string;
}): GuestTileAddress[] {
  const { app, info } = input.data;
  // Nothing to open, as on the app page.
  if (info.no_gui) {
    return [];
  }

  const urlSuffix = info.url_suffix || '';
  const addresses: GuestTileAddress[] = [];

  if (app.publicUrl) {
    addresses.push({ key: 'public', url: `${app.publicUrl}${urlSuffix}`, label: app.publicUrl.replace(/^https:\/\//, '') });
  } else if (app.exposed && app.domain) {
    const authority = `${app.domain}${input.sslPort === 443 ? '' : `:${input.sslPort}`}`;
    addresses.push({ key: 'public', url: `https://${authority}${urlSuffix}`, label: authority });
  }

  const directPort = app.port ?? info.port ?? null;
  if (!directPort) {
    return addresses;
  }

  // On the node's own name Tailscale Serve holds a Private VPN app's port, over HTTPS and whether or not the host port is open.
  const viewer = input.viewerHostname.toLowerCase().replace(/\.+$/, '');
  if (app.exposureMode === 'tailscale' && viewer.endsWith(TAILNET_HOST_SUFFIX)) {
    addresses.push({ key: 'vpn', url: `https://${viewer}:${directPort}${urlSuffix}`, label: `${viewer}:${directPort}` });
    return addresses;
  }

  const publishesPort = hasDirectLocalAccess(app, { hasHostPort: true, dynamicConfig: info.dynamic_config });
  const host = publishesPort ? guestPortHost(info, input.viewerHostname, input.publicDomain) : null;

  if (host) {
    addresses.push({ key: 'local', url: `${info.https ? 'https' : 'http'}://${host}:${directPort}${urlSuffix}`, label: `${host}:${directPort}` });
  }

  return addresses;
}
