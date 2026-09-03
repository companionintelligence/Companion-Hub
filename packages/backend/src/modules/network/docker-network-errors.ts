/**
 * True when Docker/Moby rejected bridge network creation due to overlapping IPv4 pools.
 *
 * Intentionally excludes bare "cannot create network" — Docker uses that prefix for name
 * collisions, permission failures, and invalid config as well as overlaps.
 */
export function isDockerNetworkOverlapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overlapping IPv4|Pool overlaps|address space.* overlaps/i.test(message);
}

/** Best-effort extraction of CIDR hints from Docker daemon overlap errors. */
export function extractOverlapCidrsFromError(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const matches = message.match(/\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g) ?? [];
  return [...new Set(matches)];
}
