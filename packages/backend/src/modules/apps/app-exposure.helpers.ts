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

/** True when the main service binds ${APP_PORT} on the Docker host. */
export function publishesHostPort(form: AppFormHostPortFields): boolean {
  return Boolean(form.openPort || getEffectiveExposureMode(form) === 'local' || form.exposedLocal);
}
