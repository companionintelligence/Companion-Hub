import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

import { DATA_BEARING_BIND_MOUNT_DIRS, RECREATABLE_BIND_MOUNT_DIRS } from '../lib/bind-mounts';
import {
  dockerBindMountPath,
  dockerSocketIsRootOnlyInsideContainers,
  ensureHubBindMountsWritable,
  hostPathWritable,
  probeDockerSocketOwnershipInContainer,
  quarantineAndRecreateTunnelDir,
  repairCriticalBindMountFiles,
  repairHostRootOwnedBindMounts,
  resolveHubContainerIdentity,
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
