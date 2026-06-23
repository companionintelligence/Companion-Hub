import path from 'node:path';
import { DATA_DIR } from '@/common/constants';

const CONTAINER_DATA_ROOT = '/data';

/**
 * Map container `/data/...` paths to the configured DATA_DIR when the backend
 * runs outside Docker (source-based local dev). In-container, DATA_DIR is `/data`
 * and paths pass through unchanged.
 */
export function remapContainerDataPath(
  filePath: string,
  dataDir: string = path.resolve(DATA_DIR),
  containerRoot: string = CONTAINER_DATA_ROOT,
): string {
  const resolved = path.resolve(filePath);
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedContainerRoot = path.resolve(containerRoot);

  if (resolvedDataDir === resolvedContainerRoot) {
    return resolved;
  }

  const relativePath = path.relative(resolvedContainerRoot, resolved);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return resolved;
  }

  return path.join(resolvedDataDir, relativePath);
}

export function resolveContainerDataPath(filePath: string): string {
  return remapContainerDataPath(filePath);
}
