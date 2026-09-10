import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_DATA_DIR_NAME,
  resolveCanonicalDataDir,
  resolveInvokingUserHome,
  resolveProdApplianceContext,
  settingsCandidatesFrom,
} from '../lib/paths';

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

/**
 * A device key is read from one file, but which file depends on how the Hub was installed
 * and how the CLI was invoked. Getting that wrong produced a false negative that read as a
 * statement about the Hub: `cihub pool status` under sudo printed "Hub not paired" on a node
 * routing inference to three peers, because it checked `<cwd>/.internal/state/settings.json`
 * while the key was in the owning user's canonical data dir.
 */
describe('resolveInvokingUserHome', () => {
  const always = () => true;

  it('is null when not running under sudo', () => {
    expect(resolveInvokingUserHome({}, 'linux', always)).toBeNull();
  });

  it("is null when sudo was invoked by root — root's home is already HOME", () => {
    expect(resolveInvokingUserHome({ SUDO_USER: 'root' }, 'linux', always)).toBeNull();
  });

  it('reconstructs the invoking user home per platform', () => {
    expect(resolveInvokingUserHome({ SUDO_USER: 'ci' }, 'linux', always)).toBe('/home/ci');
    expect(resolveInvokingUserHome({ SUDO_USER: 'ci' }, 'darwin', always)).toBe('/Users/ci');
  });

  it('is null when the reconstructed home does not exist, rather than a confident guess', () => {
    expect(resolveInvokingUserHome({ SUDO_USER: 'ci' }, 'linux', () => false)).toBeNull();
  });

  it('is null on Windows, which has no sudo convention to reconstruct', () => {
    expect(resolveInvokingUserHome({ SUDO_USER: 'ci' }, 'win32', always)).toBeNull();
  });
});

describe('settingsCandidatesFrom', () => {
  const always = () => true;
  const ROOT = '/srv/hub/.internal';

  it('tries the configured ROOT_FOLDER_HOST first, then the canonical data dir', () => {
    expect(settingsCandidatesFrom(ROOT, {}, 'linux', '/home/ci', always)).toEqual([
      join(ROOT, 'state', 'settings.json'),
      join('/home/ci', '.local', 'share', CANONICAL_DATA_DIR_NAME, 'state', 'settings.json'),
    ]);
  });

  // The reported bug: sudo sets HOME=/root, so the canonical dir resolves to root's home
  // and misses a key sitting in the owning user's.
  it("under sudo, also looks in the invoking user's canonical data dir", () => {
    const candidates = settingsCandidatesFrom(ROOT, { SUDO_USER: 'ci' }, 'linux', '/root', always);
    expect(candidates).toContain(join('/home/ci', '.local', 'share', CANONICAL_DATA_DIR_NAME, 'state', 'settings.json'));
    // and root's own is still checked, before it
    expect(candidates.indexOf(join('/root', '.local', 'share', CANONICAL_DATA_DIR_NAME, 'state', 'settings.json'))).toBeLessThan(
      candidates.indexOf(join('/home/ci', '.local', 'share', CANONICAL_DATA_DIR_NAME, 'state', 'settings.json')),
    );
  });

  it('ignores a sudo-inherited XDG_DATA_HOME when reconstructing the invoking user dir', () => {
    const candidates = settingsCandidatesFrom(ROOT, { SUDO_USER: 'ci', XDG_DATA_HOME: '/root/.local/share' }, 'linux', '/root', always);
    expect(candidates).toContain(join('/home/ci', '.local', 'share', CANONICAL_DATA_DIR_NAME, 'state', 'settings.json'));
  });

  it('does not widen past an explicit CI_HUB_DATA_DIR — the operator named the answer', () => {
    const candidates = settingsCandidatesFrom(ROOT, { CI_HUB_DATA_DIR: '/custom/hub', SUDO_USER: 'ci' }, 'linux', '/root', always);
    expect(candidates).toEqual([join(ROOT, 'state', 'settings.json'), join('/custom/hub', 'state', 'settings.json')]);
  });

  it('does not repeat a path when two rules resolve to the same file', () => {
    const canonical = join('/home/ci', '.local', 'share', CANONICAL_DATA_DIR_NAME);
    const candidates = settingsCandidatesFrom(canonical, {}, 'linux', '/home/ci', always);
    expect(candidates).toEqual([join(canonical, 'state', 'settings.json')]);
  });
});
