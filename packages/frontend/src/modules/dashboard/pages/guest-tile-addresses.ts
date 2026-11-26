import type { GuestAppsDto } from '@/api-client';
import { hasDirectLocalAccess, isLoopbackHost, resolveReachableHubHost } from '@/modules/app/components/app-access-points/app-access-points';

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
 * or tailnet address, the name the browser used to reach this page is one it can reach, but only for
 * a port the operator opened on the network: any other is published on 127.0.0.1, and a Private VPN
 * app's always is (`portAnswersNetwork`, which the Hub answers as `hostPortOnNetwork`). From the
 * public hostname nothing is: the tunnel carries 443 only.
 */
function guestPortHost(data: GuestAppsDto['installed'][number], viewerHostname: string, publicDomain: string): string | null {
  if (isLoopbackHost(viewerHostname)) {
    return LOOPBACK_HOST;
  }

  if (data.app.hostPortOnNetwork !== true) {
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

  // On the node's own name Tailscale Serve holds a Private VPN app's port, over HTTPS and whether or not the host port is open.
  // An app on its own Tailscale Service answers on 443 of `<label>.<tailnet>.ts.net` instead, and nothing listens on that port.
  const viewer = input.viewerHostname.toLowerCase().replace(/\.+$/, '');
  if (app.exposureMode === 'tailscale' && viewer.endsWith(TAILNET_HOST_SUFFIX)) {
    // `<node>.<tailnet>.ts.net`: the Service is on the same tailnet as the name this page was opened on.
    const tailnet = viewer.split('.').length >= 4 ? viewer.slice(viewer.indexOf('.') + 1) : null;
    const service = app.tailscaleServiceLabel && tailnet ? `${app.tailscaleServiceLabel.toLowerCase()}.${tailnet}` : null;
    if (service) {
      addresses.push({ key: 'vpn', url: `https://${service}${urlSuffix || '/'}`, label: service });
    } else if (directPort) {
      addresses.push({ key: 'vpn', url: `https://${viewer}:${directPort}${urlSuffix}`, label: `${viewer}:${directPort}` });
    }
    return addresses;
  }

  if (!directPort) {
    return addresses;
  }

  const publishesPort = hasDirectLocalAccess(app, { hasHostPort: true, dynamicConfig: info.dynamic_config });
  const host = publishesPort ? guestPortHost(input.data, input.viewerHostname, input.publicDomain) : null;

  if (host) {
    addresses.push({ key: 'local', url: `${info.https ? 'https' : 'http'}://${host}:${directPort}${urlSuffix}`, label: `${host}:${directPort}` });
  }

  return addresses;
}
