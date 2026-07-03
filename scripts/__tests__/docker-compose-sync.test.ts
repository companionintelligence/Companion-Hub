/**
 * Ensures desktop bundled compose matches the canonical root docker-compose.prod.yml.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const rootCompose = path.join(repoRoot, 'docker-compose.prod.yml');
const desktopCompose = path.join(repoRoot, 'packages/desktop/src-tauri/resources/docker-compose.prod.yml');

function readCompose(p: string) {
  return fs.readFileSync(p, 'utf-8');
}

function extractEnvDefault(content: string, key: string) {
  const re = new RegExp(`${key}:\\s*\\$\\{${key}:-([^}]+)\\}`);
  const match = content.match(re);
  return match?.[1] ?? null;
}

describe('docker-compose.prod.yml sync', () => {
  it('desktop bundle matches root after sync script', () => {
    execSync('node scripts/sync-docker-compose-prod.cjs', { cwd: repoRoot, stdio: 'pipe' });
    expect(readCompose(rootCompose)).toBe(readCompose(desktopCompose));
  });

  it('inference URLs default to host.docker.internal', () => {
    const content = readCompose(rootCompose);
    expect(extractEnvDefault(content, 'VLLM_URL')).toBe('http://host.docker.internal:8000');
    expect(extractEnvDefault(content, 'LEMONADE_URL')).toBe('http://host.docker.internal:13305');
  });

  it('tunnel mount uses sibling ../tunnel beside ROOT_FOLDER_HOST (not .internal/tunnel)', () => {
    const content = readCompose(rootCompose);
    // ROOT_FOLDER_HOST is .internal; tunnel token lives at <repo>/tunnel (sibling), matching
    // scripts/heal-hub-bind-mounts.ts resolveTunnelDir() and cihub-cli token paths.
    expect(content).toContain('${ROOT_FOLDER_HOST:-.internal}/../tunnel:/app/tunnel');
    expect(content).toContain('${ROOT_FOLDER_HOST:-.internal}/../tunnel:/home/nonroot/.cloudflared:ro');
    expect(content).not.toContain('${ROOT_FOLDER_HOST:-.internal}/tunnel:/app/tunnel');
  });
});
