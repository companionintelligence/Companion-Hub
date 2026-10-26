import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

const execAsyncMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
vi.mock('@/common/helpers/exec-helpers', () => ({ execAsync: execAsyncMock }));

// Only the probe is stubbed, so each test decides what the app-data mount can carry.
const posixProbe = vi.fn(async (_dirPath: string) => true);
vi.mock('@/common/helpers/bind-mount-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/bind-mount-helpers')>()),
  supportsPosixPermissions: posixProbe,
}));

const { AppFilesManager, buildPermissionsCommand } = await import('../app-files-manager');

/*
 * The a+rwx sweep over an app's data tree is the standing way of letting a
 * container of unknown uid write its bind mounts. What these pin is what the
 * sweep must leave alone: `app.env` (credentials, read by nobody but the Hub)
 * and any volume the manifest marks `private: true` (Memory's secrets). Both
 * were 777 on a live install before this (2026-09-24 audit, Hub findings).
 */
describe('buildPermissionsCommand', () => {
  it('is the historical recursive chmod when nothing is excluded', () => {
    expect(buildPermissionsCommand('/app-data/store/app', [])).toBe("chmod -Rf a+rwx '/app-data/store/app'");
  });

  it('prunes every excluded path (and so its subtree) and chmods the rest', () => {
    const cmd = buildPermissionsCommand('/app-data/store/app', ['/app-data/store/app/data/secrets', '/app-data/store/app/app.env']);

    expect(cmd).toBe(
      "find '/app-data/store/app' \\( -path '/app-data/store/app/data/secrets' -o -path '/app-data/store/app/app.env' \\) -prune -o ! -type l -exec chmod -f a+rwx {} +",
    );
  });

  /*
   * A Hub that runs as a plain user cannot chmod what another user owns or list a folder
   * another user closed. MariaDB keeps its schemas at 700 under uid 999 and a container running as
   * root re-creates its folders as root, so the sweep failed on every start of those apps and logged
   * "Error setting permissions" for apps that work.
   */
  it('for a Hub running as a plain user, changes only what that user owns and skips folders closed to it', () => {
    const cmd = buildPermissionsCommand('/app-data/store/app', ['/app-data/store/app/app.env'], 1000);

    expect(cmd).toBe(
      "find '/app-data/store/app' \\( -path '/app-data/store/app/app.env' -o -type d ! -user 1000 ! -perm -005 \\) -prune -o ! -type l -user 1000 -exec chmod -f a+rwx {} +",
    );
  });

  it('for a Hub running as a plain user with nothing excluded, still keeps to what it owns', () => {
    expect(buildPermissionsCommand('/app-data/store/app', [], 1000)).toBe(
      "find '/app-data/store/app' \\( -type d ! -user 1000 ! -perm -005 \\) -prune -o ! -type l -user 1000 -exec chmod -f a+rwx {} +",
    );
  });

  it.each([0, undefined])('for a Hub running as root (uid %s), is the sweep it always was', (uid) => {
    expect(buildPermissionsCommand('/app-data/store/app', [], uid)).toBe("chmod -Rf a+rwx '/app-data/store/app'");
    expect(buildPermissionsCommand('/app-data/store/app', ['/app-data/store/app/app.env'], uid)).toBe(
      "find '/app-data/store/app' \\( -path '/app-data/store/app/app.env' \\) -prune -o ! -type l -exec chmod -f a+rwx {} +",
    );
  });

  it('never puts anything but a whole number into the shell as the uid', () => {
    expect(buildPermissionsCommand('/app-data/store/app', [], Number.NaN)).toBe("chmod -Rf a+rwx '/app-data/store/app'");
    expect(buildPermissionsCommand('/app-data/store/app', [], 1.5)).toBe("chmod -Rf a+rwx '/app-data/store/app'");
  });

  it('quotes a single quote in a path so it cannot end the shell word', () => {
    const cmd = buildPermissionsCommand("/app-data/o'brien/app", ["/app-data/o'brien/app/app.env"]);

    // `'` closes the word, `\'` supplies a literal quote, `'` reopens it.
    expect(cmd).toContain("'/app-data/o'\\''brien/app'");
    expect(cmd).toContain("'/app-data/o'\\''brien/app/app.env'");
  });
});

describe('AppFilesManager.setAppDataDirPermissions', () => {
  const appUrn = 'ci-memory:ci-marketplace' as AppUrn;
  const appDataDir = path.resolve('/app-data/ci-marketplace/ci-memory');

  let filesystem: { pathExists: ReturnType<typeof vi.fn>; readJsonFile: ReturnType<typeof vi.fn> };
  let manager: InstanceType<typeof AppFilesManager>;
  let logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let chmod: ReturnType<typeof vi.spyOn>;
  let lstat: ReturnType<typeof vi.spyOn>;

  const composeWith = (volumes: Array<Record<string, unknown>>) => ({
    schemaVersion: 2,
    services: [{ name: 'setup-secrets', image: 'ghcr.io/x/setup-secrets:1', volumes }],
  });

  // The method returns early on win32, so a Windows dev box would otherwise skip every
  // assertion below (and pass the SECURITY one vacuously). Pin the backend's real platform.
  const originalPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    setPlatform('linux');
    execAsyncMock.mockClear();
    posixProbe.mockReset();
    posixProbe.mockResolvedValue(true);
    filesystem = { pathExists: vi.fn(async () => true), readJsonFile: vi.fn() };
    const configuration = {
      getConfig: () => ({ directories: { dataDir: '/data', appDataDir: '/app-data', appDir: '/app' } }),
    } as unknown as ConfigurationService;
    logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    manager = new AppFilesManager(configuration, filesystem as unknown as FilesystemService, logger as unknown as LoggerService);
    chmod = vi.spyOn(fs.promises, 'chmod').mockResolvedValue(undefined);
    lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation((async () => ({ isSymbolicLink: () => false })) as unknown as typeof fs.promises.lstat);
  });

  it('keeps app.env out of the sweep and makes it 600, even for an app with no private volumes', async () => {
    filesystem.readJsonFile.mockResolvedValue(composeWith([{ hostPath: '${APP_DATA_DIR}/data', containerPath: '/data' }]));

    await manager.setAppDataDirPermissions(appUrn);

    const cmd = execAsyncMock.mock.calls[0]?.[0] as string;
    expect(cmd).toContain(`-path '${path.join(appDataDir, 'app.env')}'`);
    expect(cmd).not.toContain("-path '/app-data/ci-marketplace/ci-memory/data'");
    expect(chmod).toHaveBeenCalledWith(path.join(appDataDir, 'app.env'), 0o600);
  });

  it('prunes a private volume from the sweep and pins it at 700', async () => {
    filesystem.readJsonFile.mockResolvedValue(
      composeWith([
        { hostPath: '${APP_DATA_DIR}/data/secrets', containerPath: '/run/secrets', private: true },
        { hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/var/lib/postgresql' },
      ]),
    );

    await manager.setAppDataDirPermissions(appUrn);

    const secrets = path.join(appDataDir, 'data', 'secrets');
    const cmd = execAsyncMock.mock.calls[0]?.[0] as string;
    expect(cmd).toContain(`-path '${secrets}'`);
    expect(cmd).not.toContain(`-path '${path.join(appDataDir, 'data', 'db')}'`);
    expect(chmod).toHaveBeenCalledWith(secrets, 0o700);
  });

  it('SECURITY: a private hostPath outside the app data dir is ignored, never chmodded', async () => {
    filesystem.readJsonFile.mockResolvedValue(
      composeWith([
        { hostPath: '/etc', containerPath: '/host-etc', private: true },
        { hostPath: '${APP_DATA_DIR}/../other-app/data', containerPath: '/x', private: true },
        { hostPath: '${APP_DATA_DIR}/..', containerPath: '/store', private: true },
        { hostPath: '${APP_DATA_DIR}', containerPath: '/all', private: true },
      ]),
    );

    await manager.setAppDataDirPermissions(appUrn);

    expect(await manager.getPrivateVolumePaths(appUrn)).toEqual([]);
    // The one path above the app's own folder is the store folder the Hub closes, never one a manifest names.
    for (const call of chmod.mock.calls) {
      expect(String(call[0]) === path.dirname(appDataDir) || String(call[0]).startsWith(`${appDataDir}${path.sep}`)).toBe(true);
    }
    expect(chmod.mock.calls.filter((call) => String(call[0]) === path.dirname(appDataDir))).toHaveLength(1);
  });

  it("closes the folder that holds the store's apps to every other local account", async () => {
    filesystem.readJsonFile.mockResolvedValue(composeWith([{ hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/var/lib/postgresql' }]));

    await manager.setAppDataDirPermissions(appUrn);

    // After the sweep, which leaves the app's own folders writable by any container's uid.
    const storeCall = chmod.mock.calls.findIndex((call) => call[0] === path.resolve('/app-data/ci-marketplace'));
    expect(storeCall).toBeGreaterThanOrEqual(0);
    expect(chmod.mock.calls[storeCall]?.[1]).toBe(0o700);
    expect(chmod.mock.invocationCallOrder[storeCall]).toBeGreaterThan(execAsyncMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    // Nothing above the store folder, and not the app-data root that holds every store.
    expect(chmod).not.toHaveBeenCalledWith(path.resolve('/app-data'), expect.anything());
  });

  it('never closes the app-data root, even for a URN whose store half resolves to it', async () => {
    filesystem.readJsonFile.mockResolvedValue(composeWith([]));

    await manager.setAppDataDirPermissions('ci-memory:.' as AppUrn);

    expect(chmod).not.toHaveBeenCalledWith(path.resolve('/app-data'), expect.anything());
    expect(chmod).not.toHaveBeenCalledWith(path.resolve('/'), expect.anything());
  });

  it('warns once when the store folder belongs to another user and cannot be closed', async () => {
    filesystem.readJsonFile.mockResolvedValue(composeWith([]));
    const storeDir = path.resolve('/app-data/ci-marketplace');
    chmod.mockImplementation(async (target: fs.PathLike) => {
      if (target === storeDir) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
    });

    await manager.setAppDataDirPermissions(appUrn);
    await manager.setAppDataDirPermissions(appUrn);

    const warnings = logger.warn.mock.calls.filter((call) => String(call[0]).includes(storeDir));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain('EPERM');
  });

  it('does not follow a link a container left where app.env or a private folder was', async () => {
    const secrets = path.join(appDataDir, 'data', 'secrets');
    filesystem.readJsonFile.mockResolvedValue(
      composeWith([{ hostPath: '${APP_DATA_DIR}/data/secrets', containerPath: '/run/secrets', private: true }]),
    );
    const links = new Set([path.join(appDataDir, 'app.env'), secrets]);
    lstat.mockImplementation((async (target: fs.PathLike) => ({
      isSymbolicLink: () => links.has(String(target)),
    })) as unknown as typeof fs.promises.lstat);

    await manager.setAppDataDirPermissions(appUrn);

    expect(chmod).not.toHaveBeenCalledWith(path.join(appDataDir, 'app.env'), expect.anything());
    expect(chmod).not.toHaveBeenCalledWith(secrets, expect.anything());
    expect(chmod).toHaveBeenCalledWith(path.resolve('/app-data/ci-marketplace'), 0o700);
  });

  it("passes the Hub's own uid, so a Hub running as a plain user keeps to the files it owns", async () => {
    filesystem.readJsonFile.mockResolvedValue(composeWith([]));
    vi.spyOn(process, 'getuid').mockReturnValue(1000);

    await manager.setAppDataDirPermissions(appUrn);

    const cmd = execAsyncMock.mock.calls[0]?.[0] as string;
    expect(cmd).toContain('-type d ! -user 1000 ! -perm -005');
    expect(cmd).toContain('-o ! -type l -user 1000 -exec chmod -f a+rwx {} +');
  });

  it('falls back to the plain sweep of everything but app.env when the manifest is unreadable', async () => {
    filesystem.readJsonFile.mockResolvedValue({ not: 'a manifest' });

    await manager.setAppDataDirPermissions(appUrn);

    const cmd = execAsyncMock.mock.calls[0]?.[0] as string;
    expect(cmd).toContain(`-path '${path.join(appDataDir, 'app.env')}'`);
    expect(cmd.match(/-path/g)).toHaveLength(1);
  });

  it('tolerates a missing app.env (nothing to chmod yet) without logging an error', async () => {
    filesystem.readJsonFile.mockResolvedValue(composeWith([]));
    chmod.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(manager.setAppDataDirPermissions(appUrn)).resolves.toBeUndefined();
  });

  /*
   * On a Windows Hub the backend runs in a Linux container, so the platform cannot tell a drvfs
   * mount (which keeps no mode a chmod sets, only the read-only bit) from a real one. The probe
   * the compose builder already asks can.
   */
  describe('on the mount the app data lives on', () => {
    it('skips the sweep when the app-data mount cannot carry POSIX permissions', async () => {
      posixProbe.mockResolvedValue(false);
      filesystem.readJsonFile.mockResolvedValue(
        composeWith([{ hostPath: '${APP_DATA_DIR}/data/secrets', containerPath: '/run/secrets', private: true }]),
      );

      await manager.setAppDataDirPermissions(appUrn);

      expect(execAsyncMock).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
    });

    it('asks about the app-data root, the folder the compose builder probes', async () => {
      filesystem.readJsonFile.mockResolvedValue(composeWith([]));

      await manager.setAppDataDirPermissions(appUrn);

      expect(posixProbe).toHaveBeenCalledWith('/app-data');
      expect(posixProbe).not.toHaveBeenCalledWith(appDataDir);
    });

    it.each(['linux', 'darwin'] as const)('still sweeps on %s when the mount carries POSIX permissions', async (platform) => {
      setPlatform(platform);
      filesystem.readJsonFile.mockResolvedValue(composeWith([]));

      await manager.setAppDataDirPermissions(appUrn);

      expect(execAsyncMock).toHaveBeenCalledTimes(1);
      expect(execAsyncMock.mock.calls[0]?.[0]).toContain(`-path '${path.join(appDataDir, 'app.env')}'`);
      expect(chmod).toHaveBeenCalledWith(path.join(appDataDir, 'app.env'), 0o600);
    });
  });
});
