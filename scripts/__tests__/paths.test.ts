import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_DATA_DIR_NAME,
  hostRootFolder,
  resolveCanonicalDataDir,
  resolveInvokingUserHome,
  resolveProdApplianceContext,
  resolveRootFolderHostForRuntime,
  settingsCandidatesFrom,
  usableXdgDataHome,
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

/**
 * A snap app points XDG_DATA_HOME at its own folder for every process it starts, so `cihub` run in
 * the terminal of VS Code installed as a snap read `~/snap/code/<rev>/.local/share/companion-hub`,
 * a stale or empty copy, instead of the Hub's data dir (CI-Hub#1698).
 */
describe('XDG_DATA_HOME set by a snap', () => {
  const HOME = '/home/tester';
  const realDataDir = join(HOME, '.local', 'share', CANONICAL_DATA_DIR_NAME);
  const codeSnapData = join(HOME, 'snap', 'code', '264', '.local', 'share');

  it("ignores another snap's folder inside that snap's terminal", () => {
    expect(resolveCanonicalDataDir({ XDG_DATA_HOME: codeSnapData, SNAP_NAME: 'code' }, 'linux', HOME)).toBe(realDataDir);
  });

  it("ignores another snap's folder even without SNAP_NAME, as a process that inherited it has", () => {
    expect(resolveCanonicalDataDir({ XDG_DATA_HOME: codeSnapData }, 'linux', HOME)).toBe(realDataDir);
  });

  it('ignores XDG_DATA_HOME whenever another snap is running the CLI', () => {
    expect(resolveCanonicalDataDir({ XDG_DATA_HOME: '/xdg/data', SNAP_NAME: 'code' }, 'linux', HOME)).toBe(realDataDir);
  });

  it('keeps the folder our own snap sets, which the desktop app in it uses too', () => {
    const ownSnapData = join(HOME, 'snap', 'companion-hub', '12', '.local', 'share');
    expect(resolveCanonicalDataDir({ XDG_DATA_HOME: ownSnapData, SNAP_NAME: 'companion-hub' }, 'linux', HOME)).toBe(
      join(ownSnapData, CANONICAL_DATA_DIR_NAME),
    );
    // A parallel install lives in `~/snap/<name>_<key>/`.
    const instanceData = join(HOME, 'snap', 'companion-hub_beta', '3', '.local', 'share');
    expect(usableXdgDataHome({ XDG_DATA_HOME: instanceData, SNAP_NAME: 'companion-hub' }, HOME)).toBe(instanceData);
  });

  it('ignores a relative XDG_DATA_HOME, as the desktop app does', () => {
    expect(resolveCanonicalDataDir({ XDG_DATA_HOME: 'xdg/data' }, 'linux', HOME)).toBe(realDataDir);
    expect(usableXdgDataHome({ XDG_DATA_HOME: ' /xdg/data' }, HOME)).toBeUndefined();
  });

  it('keeps an XDG_DATA_HOME outside any snap folder', () => {
    expect(usableXdgDataHome({ XDG_DATA_HOME: '/xdg/data' }, HOME)).toBe('/xdg/data');
    expect(usableXdgDataHome({ XDG_DATA_HOME: join(HOME, 'snapshots', 'share') }, HOME)).toBe(join(HOME, 'snapshots', 'share'));
    expect(usableXdgDataHome({ XDG_DATA_HOME: '/xdg/data', SNAP_NAME: 'companion-hub' }, HOME)).toBe('/xdg/data');
  });

  it("looks for the device key in the real data dir from another snap's terminal", () => {
    const candidates = settingsCandidatesFrom('/srv/hub/.internal', { XDG_DATA_HOME: codeSnapData, SNAP_NAME: 'code' }, 'linux', HOME, () => true);
    expect(candidates).toContain(join(realDataDir, 'state', 'settings.json'));
    expect(candidates.some((candidate) => candidate.startsWith(join(HOME, 'snap')))).toBe(false);
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

/**
 * On Windows the desktop app stores ROOT_FOLDER_HOST in Docker's form: `/mnt/c/Users/...` for the
 * WSL engine, `/c/Users/...` for Docker Desktop. Node reads either as an absolute path on the current
 * drive, so `cihub up` wrote a second, unused copy of the data dir under `C:\mnt\c\Users\...`.
 */
describe('hostRootFolder', () => {
  const WINDOWS_DATA_DIR = String.raw`C:\Users\hub\AppData\Roaming\companion-hub`;
  const WINDOWS_CWD = String.raw`D:\work`;

  it("turns Docker's form of a Windows path back into the folder it names", () => {
    expect(hostRootFolder('/mnt/c/Users/hub/AppData/Roaming/companion-hub', 'win32', WINDOWS_CWD)).toBe(WINDOWS_DATA_DIR);
    expect(hostRootFolder('/c/Users/hub/AppData/Roaming/companion-hub', 'win32', WINDOWS_CWD)).toBe(WINDOWS_DATA_DIR);
  });

  it('keeps a native Windows path, and resolves a relative one against the cwd', () => {
    expect(hostRootFolder(WINDOWS_DATA_DIR, 'win32', WINDOWS_CWD)).toBe(WINDOWS_DATA_DIR);
    expect(hostRootFolder('.internal', 'win32', WINDOWS_CWD)).toBe(String.raw`D:\work\.internal`);
  });

  it('leaves a Linux or macOS path alone, where /mnt/c is a real folder', () => {
    expect(hostRootFolder('/mnt/c/hub', 'linux', '/srv')).toBe('/mnt/c/hub');
    expect(hostRootFolder('.internal', 'darwin', '/srv')).toBe('/srv/.internal');
  });
});

describe('resolveRootFolderHostForRuntime on Windows', () => {
  const ENV_KEYS = ['ENV_FILE', 'ROOT_FOLDER_HOST', 'CI_HUB_STATE_PATH', 'STATE_PATH'] as const;
  const saved = new Map<string, string | undefined>();
  const originalPlatform = process.platform;
  let dir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), 'cihub-root-folder-'));
    // Faked on every host, so CI on Linux runs the Windows branch too.
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the WSL engine's /mnt/c value in the env file as the data dir, not a folder under C:\\mnt", () => {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'ROOT_FOLDER_HOST=/mnt/c/Users/hub/AppData/Roaming/companion-hub\n');
    process.env.ENV_FILE = envFile;

    expect(resolveRootFolderHostForRuntime()).toBe(String.raw`C:\Users\hub\AppData\Roaming\companion-hub`);
  });

  it('reads a ROOT_FOLDER_HOST from the environment the same way when the env file names none', () => {
    process.env.ENV_FILE = join(dir, 'missing.env');
    process.env.ROOT_FOLDER_HOST = '/c/Users/hub/AppData/Roaming/companion-hub';

    expect(resolveRootFolderHostForRuntime()).toBe(String.raw`C:\Users\hub\AppData\Roaming\companion-hub`);
  });
});
