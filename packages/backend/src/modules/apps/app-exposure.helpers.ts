import { servedOpenPort } from '@ci-hub/common/schemas';
import { effectiveExposureMode } from '@ci-hub/common/types';

export type AppFormHostPortFields = {
  openPort?: boolean;
  exposedLocal?: boolean;
  exposureMode?: 'local' | 'cloudflare' | 'tailscale';
};

/** Matches compose.builder.ts effective exposure mode resolution. */
export function getEffectiveExposureMode(form: AppFormHostPortFields): 'local' | 'cloudflare' | 'tailscale' {
  return effectiveExposureMode(form);
}

/** True when the main service binds ${APP_PORT} on the Docker host. A form with no `openPort` is served on an open one (`servedOpenPort`). */
export function publishesHostPort(form: AppFormHostPortFields): boolean {
  return servedOpenPort(form) || getEffectiveExposureMode(form) === 'local' || Boolean(form.exposedLocal);
}

/**
 * True when a form gives an app with `force_expose` the public address it needs: Public Web, or a
 * named domain on a Hub that still allows one. Read it after the production guard clears `exposed`.
 */
export function servesForcedExposure(form: AppFormHostPortFields & { exposed?: boolean }): boolean {
  return Boolean(form.exposed) || getEffectiveExposureMode(form) === 'cloudflare';
}
