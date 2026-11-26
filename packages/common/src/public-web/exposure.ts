import { type AppInfo, hostPortStaysOnLoopback, publishesHostPortsOnNetwork, servedOpenPort } from '../schemas/app-info.js';
import { isPortExposeApp } from '../schemas/port-expose.js';

export type AppExposureMode = 'local' | 'cloudflare' | 'tailscale';

export interface AppExposureFields {
  exposureMode?: AppExposureMode | null;
  exposedLocal?: boolean | null;
}

const APP_EXPOSURE_MODES = new Set<unknown>(['local', 'cloudflare', 'tailscale'] satisfies AppExposureMode[]);

function asExposureMode(value: unknown): AppExposureMode | undefined {
  return APP_EXPOSURE_MODES.has(value) ? (value as AppExposureMode) : undefined;
}

/**
 * Whether an app is served on the public web: its effective exposure mode is `cloudflare`.
 *
 * Compose builds the tunnel router under exactly this rule, and the Traefik labels attach it in
 * no other mode. Companion Portal sync and the app page must use the same rule, or Portal
 * publishes a hostname that ends at Traefik's 404 while the page says "Enabled". An
 * `exposedLocal` flag beside another mode is therefore not public: nothing routes it.
 */
export function publishesPublicWebRoute(form: AppExposureFields): boolean {
  return effectiveExposureMode(form) === 'cloudflare';
}

/** A form that names no mode is This Machine Only, unless it carries the legacy `exposedLocal` flag. */
export function effectiveExposureMode(form: AppExposureFields): AppExposureMode {
  return form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');
}

/**
 * The exposure an installed app runs with, read from its stored install form (`app.config`).
 * Every start, restart and update generates compose from that form.
 *
 * The row's `exposure_mode`/`exposed_local` columns can say otherwise. An install that sends no
 * exposure settings (MCP `hub_install_app`, `hub-api.sh install`) stores `exposed_local = true`
 * for any exposable app while its form resolves to local, so the columns called an app public
 * that compose never routed. The columns are used only for a record that carries no form.
 */
export function storedExposureForm(app: { config?: unknown; exposureMode?: string | null; exposedLocal?: boolean | null }): {
  exposureMode?: AppExposureMode;
  exposedLocal: boolean;
} {
  const { config } = app;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const form = config as Record<string, unknown>;
    return { exposureMode: asExposureMode(form.exposureMode), exposedLocal: form.exposedLocal === true };
  }

  return { exposureMode: asExposureMode(app.exposureMode), exposedLocal: app.exposedLocal === true };
}

/** The exposure mode an installed app runs in, whether or not its stored form names one. */
export function servedExposureMode(app: Parameters<typeof storedExposureForm>[0]): AppExposureMode {
  return effectiveExposureMode(storedExposureForm(app));
}

export interface AppHostPortFields extends AppExposureFields {
  openPort?: boolean | null;
}

/**
 * True when compose binds the main service's `${APP_PORT}` on the Docker host. A form with no
 * `openPort` is served on an open one (`servedOpenPort`). Where it binds is
 * {@link publishesMainPortOnNetwork}'s answer: every interface, or 127.0.0.1 only.
 */
export function publishesHostPort(form: AppHostPortFields): boolean {
  return servedOpenPort(form) || effectiveExposureMode(form) === 'local' || Boolean(form.exposedLocal);
}

/**
 * Whether compose binds the main service's `${APP_PORT}` on every interface, the LAN and the tailnet
 * included, rather than on 127.0.0.1 only: when the operator opened the app's ports on the network
 * (`publishesHostPortsOnNetwork`), except on Private VPN.
 *
 * Tailscale Serve listens on a Private VPN app's port at the node's tailnet address. A publish on
 * every interface wants that address too. Whichever starts first wins: with Docker first, tailscaled
 * can't open its listener, so the Hub's own computer reaches the app's plain HTTP there and the
 * Private VPN link fails the TLS handshake ("wrong version number"); with tailscaled first, Docker
 * refuses the publish and the Hub moves the app to another port. 127.0.0.1 is another address, so
 * the app keeps that one beside Serve. A listing's extra ports (`addPorts`) are not Serve's and still
 * follow the operator's choice.
 */
export function publishesMainPortOnNetwork(form: AppExposureFields & { portOnNetwork?: boolean | null }, loopbackOnly: boolean): boolean {
  return effectiveExposureMode(form) !== 'tailscale' && publishesHostPortsOnNetwork(form, loopbackOnly);
}

/**
 * The fields {@link publishesHostPort} reads, taken from the stored install form (`app.config`) that
 * compose is generated from.
 *
 * Undefined for a record that carries no form, such as a guest's: the row's `exposed_local` is true
 * for any exposable app installed without exposure settings, so the columns cannot say whether
 * compose binds the host port.
 */
export function storedHostPortForm(app: Parameters<typeof storedExposureForm>[0] & { openPort?: boolean | null }): AppHostPortFields | undefined {
  const { config } = app;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return undefined;
  }

  const { openPort } = config as Record<string, unknown>;
  return { ...storedExposureForm(app), openPort: typeof openPort === 'boolean' ? openPort : undefined };
}

/**
 * Whether another computer reaches an installed app on its own port at the Hub's LAN or tailnet
 * address: compose publishes that port ({@link publishesHostPort}) on every interface
 * ({@link publishesMainPortOnNetwork}). Otherwise the port answers on 127.0.0.1 at most, so only a
 * browser on the Hub's own computer opens `<host>:<port>`. Read from the stored install form, as
 * compose is. A record with none is published on 127.0.0.1 at most.
 */
export function storedMainPortOnNetwork(app: Parameters<typeof storedHostPortForm>[0], loopbackOnly: boolean): boolean {
  const form = storedHostPortForm(app);
  if (!form) {
    return false;
  }

  const { portOnNetwork } = app.config as Record<string, unknown>;
  return publishesHostPort(form) && publishesMainPortOnNetwork({ ...form, portOnNetwork: portOnNetwork === true }, loopbackOnly);
}

/**
 * Whether another computer reaches an installed app on its own port at the Hub's LAN or tailnet address,
 * the one rule the app page, the guest dashboard and the backend's links follow.
 *
 * An app compose runs is published as {@link storedMainPortOnNetwork} says. A port-expose app's port is a
 * program on the host, which compose doesn't publish, so the switch says nothing about it. The Hub takes
 * such a port only where its container opens it at the host's Docker bridge address and tells the operator
 * a program bound to 127.0.0.1 only is not reachable and to listen on every interface. It answers the
 * network then, except on Private VPN, where it gets no LAN link.
 */
export function portAnswersNetwork(
  app: Parameters<typeof storedMainPortOnNetwork>[0],
  info: Pick<AppInfo, 'kind' | 'exposable' | 'hub_integration'>,
): boolean {
  // Both: a save through the generic config route rewrites the stored form without `kind`.
  if (isPortExposeApp(info) || isPortExposeApp(app.config as Pick<AppInfo, 'kind'> | null | undefined)) {
    return servedExposureMode(app) !== 'tailscale';
  }

  return storedMainPortOnNetwork(app, hostPortStaysOnLoopback(info));
}
