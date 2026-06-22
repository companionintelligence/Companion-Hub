export type AppFormHostPortFields = {
  openPort?: boolean;
  exposedLocal?: boolean;
  exposureMode?: 'local' | 'cloudflare' | 'tailscale';
};

/** Matches compose.builder.ts effective exposure mode resolution. */
export function getEffectiveExposureMode(form: AppFormHostPortFields): 'local' | 'cloudflare' | 'tailscale' {
  return form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');
}

/** True when the main service binds ${APP_PORT} on the Docker host. */
export function publishesHostPort(form: AppFormHostPortFields): boolean {
  const effectiveExposureMode = getEffectiveExposureMode(form);
  return Boolean(form.openPort || effectiveExposureMode === 'local' || form.exposedLocal);
}
