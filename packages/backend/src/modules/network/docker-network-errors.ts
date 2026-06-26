export function isDockerNetworkOverlapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overlapping IPv4|cannot create network|Pool overlaps/i.test(message);
}
