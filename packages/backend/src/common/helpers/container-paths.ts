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
  const normalizedContainerRoot = path.posix.resolve('/', containerRoot);
  const normalizedContainerPath = path.posix.normalize(filePath.replaceAll('\\', '/'));

  if (!normalizedContainerPath.startsWith('/')) {
    return resolved;
  }

  const relativePath = path.posix.relative(normalizedContainerRoot, normalizedContainerPath);
  if (relativePath.startsWith('..') || path.posix.isAbsolute(relativePath)) {
    return resolved;
  }

  return relativePath ? path.join(resolvedDataDir, relativePath) : resolvedDataDir;
}

export function resolveContainerDataPath(filePath: string): string {
  return remapContainerDataPath(filePath);
}
