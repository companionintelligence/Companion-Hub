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
  return (form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local')) === 'cloudflare';
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
