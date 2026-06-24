import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANONICAL_DATA_DIR_NAME, resolveCanonicalDataDir, resolveProdApplianceContext } from '../lib/paths';

describe('resolveCanonicalDataDir', () => {
  const HOME = '/home/tester';

  it('honors a CI_HUB_DATA_DIR override on any platform', () => {
    expect(resolveCanonicalDataDir({ CI_HUB_DATA_DIR: '/custom/hub' }, 'linux', HOME)).toBe('/custom/hub');
    expect(resolveCanonicalDataDir({ CI_HUB_DATA_DIR: '/custom/hub' }, 'win32', HOME)).toBe('/custom/hub');
  });

  it('uses XDG_DATA_HOME on Linux when set', () => {
    expect(resolveCanonicalDataDir({ XDG_DATA_HOME: '/xdg/data' }, 'linux', HOME)).toBe(join('/xdg/data', CANONICAL_DATA_DIR_NAME));
  });

  it('falls back to ~/.local/share on Linux', () => {
    expect(resolveCanonicalDataDir({}, 'linux', HOME)).toBe(join(HOME, '.local', 'share', CANONICAL_DATA_DIR_NAME));
  });

  it('uses Application Support on macOS', () => {
    expect(resolveCanonicalDataDir({}, 'darwin', HOME)).toBe(join(HOME, 'Library', 'Application Support', CANONICAL_DATA_DIR_NAME));
  });

  it('uses %APPDATA% (Roaming) on Windows', () => {
    expect(resolveCanonicalDataDir({ APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, 'win32', HOME)).toBe(
      path.join('C:\\Users\\t\\AppData\\Roaming', CANONICAL_DATA_DIR_NAME),
    );
  });
});

describe('resolveProdApplianceContext', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports exists=false when the data dir has no seeded compose/env', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cihub-ctx-'));
    const ctx = resolveProdApplianceContext({ CI_HUB_DATA_DIR: dataDir }, 'linux', '/home/tester');
    expect(ctx.dataDir).toBe(dataDir);
    expect(path.isAbsolute(ctx.composePath)).toBe(true);
    expect(ctx.composePath).toBe(join(dataDir, 'docker-compose.prod.yml'));
    expect(ctx.exists).toBe(false);
  });

  it('detects a seeded prod install and prefers the platform-primary env file', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cihub-ctx-'));
    writeFileSync(join(dataDir, 'docker-compose.prod.yml'), 'services: {}\n');
    writeFileSync(join(dataDir, '.env.dev'), `ROOT_FOLDER_HOST=${dataDir}\n`);
    writeFileSync(join(dataDir, '.env'), `ROOT_FOLDER_HOST=${dataDir}\n`);
    const ctx = resolveProdApplianceContext({ CI_HUB_DATA_DIR: dataDir }, 'linux', '/home/tester');
    expect(ctx.exists).toBe(true);
    expect(ctx.envFilePath).toBe(join(dataDir, '.env.dev'));
  });
});
