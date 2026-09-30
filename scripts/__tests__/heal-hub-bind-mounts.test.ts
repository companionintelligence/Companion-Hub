import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// A test cannot create a file owned by root or by another user, so it names the owner the host
// should report for a path instead, and records chowns rather than attempting them. Everything
// else about the file, its mode above all, is real.
const { fakeOwners, chownSyncMock } = vi.hoisted(() => ({
  fakeOwners: new Map<string, { uid: number; gid: number }>(),
  chownSyncMock: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const statSync = ((target: import('node:fs').PathLike, options?: import('node:fs').StatSyncOptions) => {
    const st = actual.statSync(target, options);
    const owner = fakeOwners.get(path.resolve(String(target)));
    return st && owner ? Object.assign(st, owner) : st;
  }) as typeof actual.statSync;
  const chownSync = (...args: Parameters<typeof actual.chownSync>) => chownSyncMock(...args);
  return { ...actual, default: { ...actual, statSync, chownSync }, statSync, chownSync };
});

import { DATA_BEARING_BIND_MOUNT_DIRS, RECREATABLE_BIND_MOUNT_DIRS } from '../lib/bind-mounts';
import {
  bindMountHealScript,
  dockerBindMountPath,
  dockerSocketIsRootOnlyInsideContainers,
  ensureHubBindMountsWritable,
  hostPathWritable,
  probeDockerSocketOwnershipInContainer,
  quarantineAndRecreateTunnelDir,
  repairCriticalBindMountFiles,
  restrictPrivateStateFile,
  repairHostRootOwnedBindMounts,
  resolveHubContainerIdentity,
  resolveHubRuntimeIdentity,
  resolveTraefikHubRoutePath,
  resolveTunnelTokenPath,
} from '../heal-hub-bind-mounts';

describe('resolveHubContainerIdentity', () => {
  beforeEach(() => {
    delete process.env.CI_HUB_CONTAINER_UID;
    delete process.env.CI_HUB_CONTAINER_GID;
    execSyncMock.mockReset();
    spawnSyncMock.mockReset();
  });

  it('prefers explicit env UID/GID', () => {
    process.env.CI_HUB_CONTAINER_UID = '1000';
    process.env.CI_HUB_CONTAINER_GID = '1000';
    expect(resolveHubContainerIdentity()).toEqual({
      uid: 1000,
      gid: 1000,
      dockerGid: expect.any(Number),
      source: 'env',
    });
  });

  it('uses root identity when docker socket is root-only inside containers', () => {
    spawnSyncMock.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'docker' && args?.includes('stat') && args.includes('%u:%g')) {
        return { status: 0, stdout: '0:0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(resolveHubContainerIdentity()).toMatchObject({ uid: 0, gid: 0, source: 'docker-desktop-root' });
  });
});

describe('probeDockerSocketOwnershipInContainer', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('invokes docker with argv (no shell) so stat format is not mangled on Windows', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '1000:1000\n', stderr: '' });
    expect(probeDockerSocketOwnershipInContainer()).toBe('1000:1000');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['stat', '-c', '%u:%g', '/var/run/docker.sock']),
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('reports root-only socket ownership', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '0:0\n', stderr: '' });
    expect(dockerSocketIsRootOnlyInsideContainers()).toBe(true);
  });
});

function makeHubDataLayout(baseDir: string): { internalRoot: string; hubRoot: string } {
  const hubRoot = join(baseDir, 'hub');
  const internalRoot = join(hubRoot, '.internal');
  mkdirSync(internalRoot, { recursive: true });
  return { internalRoot, hubRoot };
}

describe('ensureHubBindMountsWritable', () => {
  const tmpRoot = join(process.cwd(), '.tmp-heal-hub-bind-mounts-test');

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
    spawnSyncMock.mockReset();
    execSyncMock.mockReset();
    process.env.CI_HUB_CONTAINER_UID = '1000';
    process.env.CI_HUB_CONTAINER_GID = '1000';
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).includes('docker info')) return '';
      throw new Error('docker unavailable');
    });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('seeds settings.json and passes when container write probe succeeds', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { internalRoot } = makeHubDataLayout(tmpRoot);

    const identity = ensureHubBindMountsWritable(internalRoot, { skipDockerHeal: false });

    expect(identity.uid).toBe(1000);
    expect(existsSync(join(internalRoot, 'state', 'settings.json'))).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalled();
  });

  it('repairs bind mounts when container write probes initially fail', () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'denied' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'denied' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'denied' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'denied' })
      .mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { internalRoot } = makeHubDataLayout(tmpRoot);

    ensureHubBindMountsWritable(internalRoot);

    expect(existsSync(join(internalRoot, 'state', 'settings.json'))).toBe(true);
    expect(spawnSyncMock.mock.calls.some((call) => call[0] === 'docker')).toBe(true);
  });

  it('skips docker-based heal when requested and still seeds host-writable bind mounts', () => {
    const { internalRoot } = makeHubDataLayout(tmpRoot);

    const identity = ensureHubBindMountsWritable(internalRoot, { skipDockerHeal: true });

    expect(identity.uid).toBe(1000);
    expect(existsSync(join(internalRoot, 'state', 'settings.json'))).toBe(true);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

// Owners are real here, so these only mean anything where uids exist; Windows has no POSIX modes
// and the code under test returns early there.
describe.skipIf(process.platform === 'win32')('credential files in state/ (settings.json, seed)', () => {
  const tmpRoot = join(process.cwd(), '.tmp-heal-hub-private-state-test');
  // Read once, before any test stands in for root by mocking these.
  const ownUid = (process.getuid as () => number)();
  const ownGid = (process.getgid as () => number)();
  const modeOf = (filePath: string) => statSync(filePath).mode & 0o777;
  const ownedBy = (filePath: string, owner: { uid: number; gid: number }) => fakeOwners.set(path.resolve(filePath), owner);
  const root = { uid: 0, gid: 0 };
  // Not 1000, which is also the entrypoint's last-resort default: a Hub found by falling back to it
  // would pass for one found by reading the env file's owner.
  const hubUser = { uid: 1234, gid: 2345 };

  function hubEnvFile(hubRoot: string, content = 'ROOT_FOLDER_HOST=/srv/hub/.internal\n'): string {
    const envFile = join(hubRoot, '.env.dev');
    writeFileSync(envFile, content);
    chmodSync(envFile, 0o600);
    return envFile;
  }

  function stateFile(internalRoot: string, name: string, mode: number, content = '{}'): string {
    const filePath = join(internalRoot, 'state', name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    // chmod, not writeFile's mode: that one is masked by the umask, and 0666 is the point.
    chmodSync(filePath, mode);
    return filePath;
  }

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
    spawnSyncMock.mockReset();
    execSyncMock.mockReset();
    chownSyncMock.mockReset();
    fakeOwners.clear();
    // The Hub runs as this user: the ordinary install, where the container drops to the owner.
    process.env.CI_HUB_CONTAINER_UID = String(ownUid);
    process.env.CI_HUB_CONTAINER_GID = String(ownGid);
    execSyncMock.mockImplementation(() => {
      throw new Error('docker unavailable');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fakeOwners.clear();
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.CI_HUB_CONTAINER_UID;
    delete process.env.CI_HUB_CONTAINER_GID;
  });

  it('seeds a missing settings.json owner-only, not 0666', () => {
    const { internalRoot } = makeHubDataLayout(tmpRoot);

    ensureHubBindMountsWritable(internalRoot, { skipDockerHeal: true });

    expect(modeOf(join(internalRoot, 'state', 'settings.json'))).toBe(0o600);
    // Created by the user the Hub runs as, so already the Hub's.
    expect(chownSyncMock).not.toHaveBeenCalled();
  });

  it('restricts a world-writable settings.json and a world-readable seed it owns, on every start', () => {
    const { internalRoot } = makeHubDataLayout(tmpRoot);
    const settingsPath = stateFile(internalRoot, 'settings.json', 0o666, '{"hubLocalKey":"k"}');
    const seedPath = stateFile(internalRoot, 'seed', 0o644, 'a'.repeat(64));

    ensureHubBindMountsWritable(internalRoot, { skipDockerHeal: true });

    expect(modeOf(settingsPath)).toBe(0o600);
    expect(modeOf(seedPath)).toBe(0o600);
  });

  it('never loosens a stricter mode', () => {
    const { internalRoot } = makeHubDataLayout(tmpRoot);
    const seedPath = stateFile(internalRoot, 'seed', 0o400, 'a'.repeat(64));

    ensureHubBindMountsWritable(internalRoot, { skipDockerHeal: true });

    expect(modeOf(seedPath)).toBe(0o400);
  });

  it('leaves a file alone when the Hub will not own it, so it cannot lock the Hub out', () => {
    const { internalRoot } = makeHubDataLayout(tmpRoot);
    const settingsPath = stateFile(internalRoot, 'settings.json', 0o666);

    expect(restrictPrivateStateFile(settingsPath, ownUid + 1)).toBeNull();
    expect(restrictPrivateStateFile(settingsPath, null)).toBeNull();
    expect(modeOf(settingsPath)).toBe(0o666);
  });

  // `sudo cihub up` or `sudo pnpm run dev` on an install a user owns. The CLI is root, nothing is
  // pinned (init-hub-data-dirs unpins on purpose), and the container drops to the env file's owner.
  describe('driven through sudo on an install a user owns', () => {
    beforeEach(() => {
      delete process.env.CI_HUB_CONTAINER_UID;
      delete process.env.CI_HUB_CONTAINER_GID;
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      vi.spyOn(process, 'getgid').mockReturnValue(0);
      // Native Linux: the socket is root:docker inside a container, so the CLI's own guess at the
      // container identity is itself, root.
      spawnSyncMock.mockImplementation((_cmd: string, args: string[] = []) =>
        args.includes('%u:%g') ? { status: 0, stdout: '0:973\n', stderr: '' } : { status: 1, stdout: '', stderr: 'denied' },
      );
    });

    it('leaves a root-owned settings.json and seed readable by the Hub instead of locking them to root', () => {
      const { internalRoot, hubRoot } = makeHubDataLayout(tmpRoot);
      const envFile = hubEnvFile(hubRoot);
      ownedBy(envFile, hubUser);
      // What an older root-owned container left behind, and what the stale-root repairs exist for.
      const settingsPath = stateFile(internalRoot, 'settings.json', 0o666, '{"hubLocalKey":"k"}');
      const seedPath = stateFile(internalRoot, 'seed', 0o666, 'a'.repeat(64));
      ownedBy(settingsPath, root);
      ownedBy(seedPath, root);

      const identity = ensureHubBindMountsWritable(internalRoot, { envFile, skipDockerHeal: true });

      // The CLI's guess, which used to decide this. The post-heal check runs as it too, so a 0600
      // root file would pass that check.
      expect(identity.uid).toBe(0);
      // At 0600 the Hub, running as 1234, could read neither: it would set settings.json aside and
      // boot looking unpaired, and crash-loop reading seed.
      expect(modeOf(settingsPath)).toBe(0o666);
      expect(modeOf(seedPath)).toBe(0o666);
    });

    it('still restricts the files the Hub itself owns', () => {
      const { internalRoot, hubRoot } = makeHubDataLayout(tmpRoot);
      const envFile = hubEnvFile(hubRoot);
      ownedBy(envFile, hubUser);
      const settingsPath = stateFile(internalRoot, 'settings.json', 0o666, '{"hubLocalKey":"k"}');
      ownedBy(settingsPath, hubUser);

      ensureHubBindMountsWritable(internalRoot, { envFile, skipDockerHeal: true });

      expect(modeOf(settingsPath)).toBe(0o600);
    });

    it('hands a settings.json it has to create to the Hub, not to root', () => {
      const { internalRoot, hubRoot } = makeHubDataLayout(tmpRoot);
      const envFile = hubEnvFile(hubRoot);
      ownedBy(envFile, hubUser);
      const settingsPath = join(internalRoot, 'state', 'settings.json');

      ensureHubBindMountsWritable(internalRoot, { envFile, skipDockerHeal: true });

      expect(modeOf(settingsPath)).toBe(0o600);
      expect(chownSyncMock).toHaveBeenCalledWith(settingsPath, hubUser.uid, hubUser.gid);
    });

    it('follows a pin in the env file over its owner, as the entrypoint does', () => {
      const { internalRoot, hubRoot } = makeHubDataLayout(tmpRoot);
      const envFile = hubEnvFile(hubRoot, `CI_HUB_CONTAINER_UID=${hubUser.uid}\nCI_HUB_CONTAINER_GID=${hubUser.gid}\n`);
      ownedBy(envFile, root);
      const settingsPath = stateFile(internalRoot, 'settings.json', 0o666);
      ownedBy(settingsPath, root);

      ensureHubBindMountsWritable(internalRoot, { envFile, skipDockerHeal: true });

      expect(modeOf(settingsPath)).toBe(0o666);
    });
  });

  // Docker Desktop and rootless Docker, where init-hub-data-dirs pins 0:0: container root's files
  // on the host are those of the user running the engine.
  describe('when the Hub runs as root', () => {
    beforeEach(() => {
      process.env.CI_HUB_CONTAINER_UID = '0';
      process.env.CI_HUB_CONTAINER_GID = '0';
    });

    it("restricts the CLI user's own files, which are the engine user's", () => {
      const { internalRoot } = makeHubDataLayout(tmpRoot);
      const settingsPath = stateFile(internalRoot, 'settings.json', 0o666, '{"hubLocalKey":"k"}');

      ensureHubBindMountsWritable(internalRoot, { skipDockerHeal: true });

      expect(modeOf(settingsPath)).toBe(0o600);
    });

    it('leaves them to the Hub when the CLI is root as well, since whose engine it is cannot be told', () => {
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      vi.spyOn(process, 'getgid').mockReturnValue(0);
      const { internalRoot } = makeHubDataLayout(tmpRoot);
      const settingsPath = stateFile(internalRoot, 'settings.json', 0o666, '{"hubLocalKey":"k"}');
      ownedBy(settingsPath, root);

      ensureHubBindMountsWritable(internalRoot, { skipDockerHeal: true });

      expect(modeOf(settingsPath)).toBe(0o666);
      expect(chownSyncMock).not.toHaveBeenCalled();
    });
  });

  it('takes the credential files back to owner-only after the Docker heal opens the state dir up', () => {
    const { internalRoot } = makeHubDataLayout(tmpRoot);
    const settingsPath = stateFile(internalRoot, 'settings.json', 0o600, '{"hubLocalKey":"k"}');
    const seedPath = stateFile(internalRoot, 'seed', 0o600, 'a'.repeat(64));
    // The desktop app's update listener token, which the Hub only reads and the heal must not touch.
    const tokenPath = stateFile(internalRoot, 'update-listener.token', 0o600, 'listener-token\n');
    execSyncMock.mockReturnValue('');
    let healed = false;
    let stateHealed = false;
    spawnSyncMock.mockImplementation((_cmd: string, args: string[] = []) => {
      const script = args[args.length - 1] ?? '';
      const mount = args[args.indexOf('-v') + 1] ?? '';
      if (args.includes('0:0') && /chown -[Rh] /.test(script)) {
        // What the heal's chmod does to the files in state/, when it is state/ being healed: every
        // file the script does not walk around ends up world-writable.
        if (mount.startsWith(`${join(internalRoot, 'state')}:`)) {
          const kept = [...script.matchAll(/! -path '\/mnt\/([^']+)'/g)].map((match) => match[1]);
          for (const file of [settingsPath, seedPath, tokenPath]) {
            if (!kept.includes(path.basename(file))) chmodSync(file, 0o666);
          }
          stateHealed = true;
        }
        healed = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      // Every container write probe fails until the heal has run.
      return { status: healed ? 0 : 1, stdout: '', stderr: healed ? '' : 'denied' };
    });

    ensureHubBindMountsWritable(internalRoot);

    expect(stateHealed).toBe(true);
    expect(modeOf(settingsPath)).toBe(0o600);
    expect(modeOf(seedPath)).toBe(0o600);
    expect(modeOf(tokenPath)).toBe(0o600);
  });
});

describe('bindMountHealScript', () => {
  it('is the recursive chown and chmod when nothing is kept', () => {
    expect(bindMountHealScript(1000, 1000)).toBe(
      'chown -R 1000:1000 /mnt 2>/dev/null || true; chmod -R u+rwX,g+rwX,o+rwX /mnt 2>/dev/null || chmod -R a+rwX /mnt 2>/dev/null || true',
    );
  });

  it('walks around the files it keeps, and changes symlinks themselves, never their targets', () => {
    const script = bindMountHealScript(1000, 1000, ['update-listener.token']);

    const walk = "find /mnt ! -path '/mnt/update-listener.token'";
    expect(script).toContain(`${walk} -exec chown -h 1000:1000 {} +`);
    expect(script).toContain(`${walk} ! -type l -exec chmod u+rwX,g+rwX,o+rwX {} +`);
    expect(script).not.toContain(' -R ');
  });
});

// The same order docker-entrypoint.sh uses to pick the uid:gid it drops to.
describe.skipIf(process.platform === 'win32')('resolveHubRuntimeIdentity', () => {
  const tmpRoot = join(process.cwd(), '.tmp-heal-hub-runtime-identity-test');

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
    fakeOwners.clear();
    delete process.env.CI_HUB_CONTAINER_UID;
    delete process.env.CI_HUB_CONTAINER_GID;
  });

  afterEach(() => {
    fakeOwners.clear();
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.CI_HUB_CONTAINER_UID;
    delete process.env.CI_HUB_CONTAINER_GID;
  });

  function layout(envContent: string | null): { internalRoot: string; envFile: string } {
    const { internalRoot, hubRoot } = makeHubDataLayout(tmpRoot);
    mkdirSync(join(internalRoot, 'state'), { recursive: true });
    const envFile = join(hubRoot, '.env.dev');
    if (envContent !== null) writeFileSync(envFile, envContent);
    return { internalRoot, envFile };
  }

  it('takes a pin first, from the environment and then the env file, each half on its own', () => {
    const { internalRoot, envFile } = layout('CI_HUB_CONTAINER_GID=0\n');
    fakeOwners.set(path.resolve(envFile), { uid: 1234, gid: 2345 });
    process.env.CI_HUB_CONTAINER_UID = '0';

    expect(resolveHubRuntimeIdentity(internalRoot, envFile)).toEqual({ uid: 0, gid: 0 });
  });

  it("uses the env file's owner when nothing is pinned", () => {
    const { internalRoot, envFile } = layout('ROOT_FOLDER_HOST=/srv/hub/.internal\n');
    fakeOwners.set(path.resolve(envFile), { uid: 1234, gid: 2345 });
    fakeOwners.set(path.resolve(internalRoot, 'state'), { uid: 0, gid: 0 });

    expect(resolveHubRuntimeIdentity(internalRoot, envFile)).toEqual({ uid: 1234, gid: 2345 });
  });

  it("falls back to state/'s owner without an env file, and to 1000 without either", () => {
    const { internalRoot, envFile } = layout(null);
    fakeOwners.set(path.resolve(internalRoot, 'state'), { uid: 3456, gid: 4567 });

    expect(resolveHubRuntimeIdentity(internalRoot, envFile)).toEqual({ uid: 3456, gid: 4567 });
    expect(resolveHubRuntimeIdentity(join(tmpRoot, 'no-such-install'))).toEqual({ uid: 1000, gid: 1000 });
  });
});

describe('hostPathWritable', () => {
  const tmpRoot = join(process.cwd(), '.tmp-host-path-writable-test');

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns true for writable directory', () => {
    expect(hostPathWritable(tmpRoot)).toBe(true);
  });
});

describe('repairCriticalBindMountFiles', () => {
  const tmpRoot = join(process.cwd(), '.tmp-heal-critical-bind-mounts-test');

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    process.env.CI_HUB_CONTAINER_UID = '1000';
    process.env.CI_HUB_CONTAINER_GID = '1000';
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).includes('docker info')) return '';
      throw new Error('docker unavailable');
    });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('removes stale root-owned tunnel token so Hub can rewrite it', () => {
    const { internalRoot, hubRoot } = makeHubDataLayout(tmpRoot);
    const tokenPath = resolveTunnelTokenPath(internalRoot);
    mkdirSync(join(tokenPath, '..'), { recursive: true });
    writeFileSync(tokenPath, 'stale-token');
    chmodSync(tokenPath, 0o400);

    const repaired = repairCriticalBindMountFiles(internalRoot, {
      uid: 1000,
      gid: 1000,
      dockerGid: 999,
      source: 'env',
    });

    expect(repaired.some((entry) => entry.includes('tunnel'))).toBe(true);
    expect(existsSync(tokenPath)).toBe(false);
    expect(existsSync(join(hubRoot, 'tunnel'))).toBe(true);
  });

  it('resolves traefik hub route beside state/', () => {
    const { internalRoot } = makeHubDataLayout(tmpRoot);
    expect(resolveTraefikHubRoutePath(internalRoot)).toBe(join(internalRoot, 'state', 'traefik', 'dynamic', 'hub.yml'));
  });

  it('quarantines an unwritable tunnel directory without sudo', () => {
    const { internalRoot, hubRoot } = makeHubDataLayout(tmpRoot);
    const tunnelDir = join(hubRoot, 'tunnel');
    mkdirSync(tunnelDir, { recursive: true });
    const tokenPath = join(tunnelDir, 'token');
    writeFileSync(tokenPath, 'stale-token');
    chmodSync(tokenPath, 0o400);

    expect(quarantineAndRecreateTunnelDir(tunnelDir)).toBe(true);
    expect(existsSync(tokenPath)).toBe(false);
    expect(hostPathWritable(tunnelDir)).toBe(true);
    expect(
      repairCriticalBindMountFiles(internalRoot, {
        uid: 1000,
        gid: 1000,
        dockerGid: 999,
        source: 'env',
      }).some((entry) => entry.includes('tunnel')),
    ).toBe(false);
  });
});

describe('repairHostRootOwnedBindMounts policy', () => {
  it('keeps data-bearing directories out of the auto-quarantine list', () => {
    expect(RECREATABLE_BIND_MOUNT_DIRS).toEqual(['cache', 'logs', 'user-config', '.docker']);
    expect(DATA_BEARING_BIND_MOUNT_DIRS).toEqual(['apps', 'app-data', 'media', 'repos', 'backups']);
    expect(RECREATABLE_BIND_MOUNT_DIRS.some((dir) => (DATA_BEARING_BIND_MOUNT_DIRS as readonly string[]).includes(dir))).toBe(false);
  });

  it('returns blocked data dirs separately from repaired paths', () => {
    const result = repairHostRootOwnedBindMounts(join(process.cwd(), '.tmp-nonexistent-heal-root'), {
      uid: 1000,
      gid: 1000,
      dockerGid: 999,
      source: 'env',
    });
    expect(Array.isArray(result.blockedDataDirs)).toBe(true);
    expect(Array.isArray(result.repaired)).toBe(true);
  });
});

describe('dockerBindMountPath', () => {
  const originalPlatform = process.platform;
  const originalStyle = process.env.CI_HUB_DOCKER_PATH_STYLE;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalStyle === undefined) {
      delete process.env.CI_HUB_DOCKER_PATH_STYLE;
    } else {
      process.env.CI_HUB_DOCKER_PATH_STYLE = originalStyle;
    }
  });

  it('normalizes Windows paths to /<drive>/... for Docker Desktop', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.CI_HUB_DOCKER_PATH_STYLE = 'drive';
    expect(dockerBindMountPath(String.raw`C:\Users\hegem\AppData\Roaming\companion-hub\state`)).toBe(
      '/c/Users/hegem/AppData/Roaming/companion-hub/state',
    );
    expect(dockerBindMountPath('/c/Users/hegem/AppData/Roaming/companion-hub')).toBe('/c/Users/hegem/AppData/Roaming/companion-hub');
    expect(dockerBindMountPath('C:/Users/hegem/AppData/Roaming/companion-hub')).toBe('/c/Users/hegem/AppData/Roaming/companion-hub');
    expect(dockerBindMountPath('/mnt/C/Users/hegem/AppData/Roaming/companion-hub')).toBe('/c/Users/hegem/AppData/Roaming/companion-hub');
  });

  it('normalizes Windows paths to /mnt/<drive>/... for a native WSL2 engine', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.CI_HUB_DOCKER_PATH_STYLE = 'wsl-mnt';
    expect(dockerBindMountPath(String.raw`C:\Users\hegem\AppData\Roaming\companion-hub\state`)).toBe(
      '/mnt/c/Users/hegem/AppData/Roaming/companion-hub/state',
    );
    expect(dockerBindMountPath('/c/Users/hegem/AppData/Roaming/companion-hub')).toBe('/mnt/c/Users/hegem/AppData/Roaming/companion-hub');
    expect(dockerBindMountPath('C:/Users/hegem/AppData/Roaming/companion-hub')).toBe('/mnt/c/Users/hegem/AppData/Roaming/companion-hub');
    expect(dockerBindMountPath('/mnt/C/Users/hegem/AppData/Roaming/companion-hub')).toBe('/mnt/c/Users/hegem/AppData/Roaming/companion-hub');
  });

  it('normalizes MSYS /c/... inputs before Windows path resolution', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.CI_HUB_DOCKER_PATH_STYLE = 'drive';
    const mangled = path.win32.resolve('/c/Users/hegem/AppData/Roaming/companion-hub');
    expect(mangled).not.toBe('/c/Users/hegem/AppData/Roaming/companion-hub');
    expect(dockerBindMountPath('/c/Users/hegem/AppData/Roaming/companion-hub')).toBe('/c/Users/hegem/AppData/Roaming/companion-hub');
  });

  it('resolves relative paths on Windows without backslashes', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.CI_HUB_DOCKER_PATH_STYLE = 'drive';
    const resolved = dockerBindMountPath('state');
    expect(resolved).toMatch(/\/state$/);
    expect(resolved).not.toContain('\\');
  });

  it('leaves POSIX paths unchanged on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(dockerBindMountPath('/var/lib/companion-hub/state')).toBe('/var/lib/companion-hub/state');
  });
});
