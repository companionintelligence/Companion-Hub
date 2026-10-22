/**
 * Compose refuses a service's `healthcheck.start_interval` on Docker Engine older than 25 ("can't set
 * healthcheck.start_interval as feature require Docker Engine v25 or later") and creates no container,
 * so an app whose health check sets one could not be installed, started or updated there at all.
 */
export const HEALTHCHECK_START_INTERVAL_MIN_ENGINE_MAJOR = 25;

/** The engine's major version from `ServerVersion` as Docker reports it (`24.0.9`, `28.2.2-0ubuntu1`, `v25.0.3`); null when it can't be read. */
export function engineMajorVersion(serverVersion: string | null | undefined): number | null {
  const match = /(\d+)\.\d+/.exec(serverVersion ?? '');
  const major = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(major) ? major : null;
}

/**
 * The services with `healthCheck.startInterval` left out when the engine is older than 25. It only
 * makes the first health checks come sooner, so the app runs the same without it. A version that
 * can't be read keeps it, and Compose says what is wrong, as it did before. `onDropped` is called for
 * each service it changed.
 */
export function withoutUnsupportedStartInterval<T extends { name: string; healthCheck?: { startInterval?: string } }>(
  services: T[],
  serverVersion: string | null | undefined,
  onDropped: (service: T) => void,
): T[] {
  const major = engineMajorVersion(serverVersion);
  if (major === null || major >= HEALTHCHECK_START_INTERVAL_MIN_ENGINE_MAJOR) {
    return services;
  }
  return services.map((service) => {
    if (!service.healthCheck?.startInterval) {
      return service;
    }
    onDropped(service);
    const { startInterval: _dropped, ...healthCheck } = service.healthCheck;
    return { ...service, healthCheck };
  });
}
