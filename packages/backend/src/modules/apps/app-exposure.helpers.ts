import { type AppInfo, hostPortStaysOnLoopback, isPortExposeApp } from '@ci-hub/common/schemas';
import {
  effectiveExposureMode,
  publishesHostPort as publishesSharedHostPort,
  publishesPublicWebRoute,
  storedMainPortOnNetwork,
} from '@ci-hub/common/types';

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
 * Whether another computer reaches an installed app on its own port at the Hub's LAN or tailnet address.
 * Compose publishes the port on every interface only when the operator opened it on the network
 * (`storedMainPortOnNetwork`), and on 127.0.0.1 otherwise. A port-expose app's port belongs to a service
 * on the host, which the Hub doesn't publish: where it listens is that service's choice, so its address
 * stays offered as before.
 */
export function portAnswersNetwork(
  app: Parameters<typeof storedMainPortOnNetwork>[0],
  info: Pick<AppInfo, 'kind' | 'exposable' | 'hub_integration'>,
): boolean {
  if (isPortExposeApp(info) || isPortExposeApp(app.config as Pick<AppInfo, 'kind'> | null | undefined)) {
    return true;
  }

  return storedMainPortOnNetwork(app, hostPortStaysOnLoopback(info));
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
