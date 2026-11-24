import { servedOpenPort } from '../schemas/app-info.js';

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
 * True when compose binds the main service's `${APP_PORT}` on the Docker host, so the app answers on
 * the Hub's LAN address. A form with no `openPort` is served on an open one (`servedOpenPort`).
 */
export function publishesHostPort(form: AppHostPortFields): boolean {
  return servedOpenPort(form) || effectiveExposureMode(form) === 'local' || Boolean(form.exposedLocal);
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
