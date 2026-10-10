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
      "find '/app-data/store/app' \\( -path '/app-data/store/app/data/secrets' -o -path '/app-data/store/app/app.env' \\) -prune -o -exec chmod -f a+rwx {} +",
    );
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
  let chmod: ReturnType<typeof vi.spyOn>;

  const composeWith = (volumes: Array<Record<string, unknown>>) => ({
    schemaVersion: 2,
    services: [{ name: 'setup-secrets', image: 'ghcr.io/x/setup-secrets:1', volumes }],
  });

  beforeEach(() => {
    execAsyncMock.mockClear();
    posixProbe.mockReset();
    posixProbe.mockResolvedValue(true);
    filesystem = { pathExists: vi.fn(async () => true), readJsonFile: vi.fn() };
    const configuration = {
      getConfig: () => ({ directories: { dataDir: '/data', appDataDir: '/app-data', appDir: '/app' } }),
    } as unknown as ConfigurationService;
    manager = new AppFilesManager(
      configuration,
      filesystem as unknown as FilesystemService,
      {
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as LoggerService,
    );
    chmod = vi.spyOn(fs.promises, 'chmod').mockResolvedValue(undefined);
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
        { hostPath: '${APP_DATA_DIR}', containerPath: '/all', private: true },
      ]),
    );

    await manager.setAppDataDirPermissions(appUrn);

    expect(await manager.getPrivateVolumePaths(appUrn)).toEqual([]);
    for (const call of chmod.mock.calls) {
      expect(String(call[0]).startsWith(`${appDataDir}${path.sep}`)).toBe(true);
    }
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
   * A Windows drive bind-mounted through WSL2 (drvfs over 9p) discards every chmod, yet the sweep
   * still stats and chmods each file over 9p. On a Windows Hub that took minutes per restart for an
   * app with a large data tree. The backend runs in a Linux container there, so the platform alone
   * cannot tell; the probe the compose builder already asks can.
   */
  describe('on the platform the backend runs on', () => {
    const originalPlatform = process.platform;
    const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });

    afterEach(() => {
      setPlatform(originalPlatform);
    });

    it('skips the sweep when the app-data mount cannot carry POSIX permissions', async () => {
      setPlatform('linux');
      posixProbe.mockResolvedValue(false);
      filesystem.readJsonFile.mockResolvedValue(
        composeWith([{ hostPath: '${APP_DATA_DIR}/data/secrets', containerPath: '/run/secrets', private: true }]),
      );

      await manager.setAppDataDirPermissions(appUrn);

      expect(execAsyncMock).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
    });

    it('asks about the app-data root, whose answer the compose builder has already cached', async () => {
      setPlatform('linux');
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
