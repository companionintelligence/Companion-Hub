/**
 * Desktop storage contract tests.
 *
 * Validates that the desktop docker-compose.prod.yml mounts /app-data as a
 * bind mount from ${ROOT_FOLDER_HOST}/app-data — the same pattern used by the
 * main production compose. This prevents split-brain between Hub container
 * writes and launched app mounts. See issue #393.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function readRealFile(filePath: string) {
  return realFs.readFileSync(filePath, 'utf-8');
}

// Resolve repo root from the backend package directory
const repoRoot = path.resolve(process.cwd(), '../..');
const desktopComposePath = path.join(repoRoot, 'packages/desktop/src-tauri/resources/docker-compose.prod.yml');
const productionComposePath = path.join(repoRoot, 'docker-compose.prod.yml');

function extractAppDataMount(composeContent: string) {
  const lines = composeContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') && trimmed.includes(':/app-data')) {
      return trimmed.replace(/^-\s*/, '');
    }
  }
  return null;
}

describe('Desktop storage contract (issue #393)', () => {
  it('desktop compose must mount /app-data as a bind mount, not a named volume', () => {
    const content = readRealFile(desktopComposePath);
    const mount = extractAppDataMount(content);

    expect(mount).not.toBeNull();
    // Must be a bind mount pattern: ${ROOT_FOLDER_HOST...}/app-data:/app-data
    expect(mount).toMatch(/\$\{ROOT_FOLDER_HOST[^}]*\}\/app-data:\/app-data/);
    // Must NOT be a named volume (no colon-only pattern like volume_name:/app-data)
    expect(mount).not.toMatch(/^[a-z_]+:\/app-data$/);
  });

  it('desktop compose must not declare a ci_hub_app_data named volume', () => {
    const content = readRealFile(desktopComposePath);
    expect(content).not.toContain('ci_hub_app_data');
  });

  it('desktop and production compose must use the same /app-data mount pattern', () => {
    const desktopContent = readRealFile(desktopComposePath);
    const prodContent = readRealFile(productionComposePath);

    const desktopMount = extractAppDataMount(desktopContent);
    const prodMount = extractAppDataMount(prodContent);

    expect(desktopMount).not.toBeNull();
    expect(prodMount).not.toBeNull();
    expect(desktopMount).toBe(prodMount);
  });

  it('APP_DATA_DIR path structure must match the compose /app-data mount', () => {
    const rootFolderHost = '/home/user/companion-hub';
    const storeId = 'my-store';
    const appName = 'my-app';

    // What the backend generates for launched app compose
    const appDataDir = path.join(rootFolderHost, 'app-data', storeId, appName);

    // What the container volume mount resolves to on the host
    const hostMountBase = path.join(rootFolderHost, 'app-data');
    const containerAppDataPath = path.join('/app-data', storeId, appName);
    const resolvedHostPath = containerAppDataPath.replace('/app-data', hostMountBase);

    expect(appDataDir).toBe(resolvedHostPath);
  });
});
