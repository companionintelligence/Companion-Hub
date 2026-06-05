import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

import { ensureHubBindMountsWritable, hostPathWritable, resolveHubContainerIdentity } from '../heal-hub-bind-mounts';

describe('resolveHubContainerIdentity', () => {
  beforeEach(() => {
    delete process.env.CI_HUB_CONTAINER_UID;
    delete process.env.CI_HUB_CONTAINER_GID;
    execSyncMock.mockReset();
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
    execSyncMock.mockReturnValue('0:0');
    expect(resolveHubContainerIdentity()).toMatchObject({ uid: 0, gid: 0, source: 'docker-desktop-root' });
  });
});

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

    const identity = ensureHubBindMountsWritable(tmpRoot, { skipDockerHeal: false });

    expect(identity.uid).toBe(1000);
    expect(existsSync(join(tmpRoot, 'state', 'settings.json'))).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalled();
  });

  it('runs docker heal when initial container probe fails', () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'denied' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    ensureHubBindMountsWritable(tmpRoot);

    const dockerHeal = spawnSyncMock.mock.calls.find((call) => call[1]?.includes?.('0:0'));
    expect(dockerHeal).toBeTruthy();
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
