export function isDockerNetworkOverlapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overlapping IPv4|cannot create network|Pool overlaps/i.test(message);
}

/** Best-effort extraction of CIDR hints from Docker daemon overlap errors. */
export function extractOverlapCidrsFromError(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const matches = message.match(/\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g) ?? [];
  return [...new Set(matches)];
}
