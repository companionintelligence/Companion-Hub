import { effectiveExposureMode, publishesHostPort as publishesSharedHostPort, publishesPublicWebRoute } from '@ci-hub/common/types';

export type AppFormHostPortFields = {
  openPort?: boolean;
  exposedLocal?: boolean;
  exposureMode?: 'local' | 'cloudflare' | 'tailscale';
};

/** Matches compose.builder.ts effective exposure mode resolution. */
export function getEffectiveExposureMode(form: AppFormHostPortFields): 'local' | 'cloudflare' | 'tailscale' {
  return effectiveExposureMode(form);
}

/**
 * True when the main service binds ${APP_PORT} on the Docker host. Shared with the app page, which
 * offers the LAN link exactly when this holds for the stored install form.
 */
export function publishesHostPort(form: AppFormHostPortFields): boolean {
  return publishesSharedHostPort(form);
}

/**
 * True when the app's port is taken on this computer: compose publishes it on the host, or Tailscale
 * Serve listens on it at the tailnet address. Another app published on the same port would answer the
 * Hub's own computer in Serve's place. Two Private VPN apps can't both have Serve on one port either.
 */
export function holdsAppPort(form: AppFormHostPortFields): boolean {
  return publishesHostPort(form) || getEffectiveExposureMode(form) === 'tailscale';
}

/**
 * True when a form gives an app with `force_expose` the public address it needs: Public Web, or a
 * named domain on a Hub that still allows one. Read it after the production guard clears `exposed`.
 */
export function servesForcedExposure(form: AppFormHostPortFields & { exposed?: boolean }): boolean {
  return Boolean(form.exposed) || publishesPublicWebRoute(form);
}

/**
 * Gives a `force_expose` form on Public Web what env generation names a public hostname for: `exposedLocal`
 * with a closed host port (`canServeOnCustomDomain`). An API or MCP form can name the mode alone, and the
 * queue serves that on an open port, so the app would keep its LAN address as the name it first started with.
 * The Hub login stays as the form has it: on unless the operator switched it off (`requiresHubLogin`).
 */
export function publishForcedExposure(form: AppFormHostPortFields): void {
  if (!publishesPublicWebRoute(form)) {
    return;
  }
  form.exposedLocal = true;
  if (form.openPort !== false) {
    form.openPort = false;
  }
}
