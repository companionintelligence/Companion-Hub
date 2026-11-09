import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

// The real filesystem: the suite's memfs mock cannot refuse a listing, and a refused listing is the case that matters here.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { AppFilesManager } = await import('../app-files-manager');

// root ignores permission bits, so the refused listing can't be made.
const canEnforcePermissions = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

describe('AppFilesManager.hasAppData', () => {
  const appUrn = 'demo:community' as AppUrn;
  let scratch: string;
  let appDataDir: string;
  let manager: InstanceType<typeof AppFilesManager>;

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'has-app-data-'));
    appDataDir = path.join(scratch, 'app-data', 'community', 'demo');
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as LoggerService;
    const configuration = {
      getConfig: () => ({ directories: { dataDir: scratch, appDataDir: path.join(scratch, 'app-data'), appDir: scratch } }),
    } as unknown as ConfigurationService;
    manager = new AppFilesManager(configuration, new FilesystemService(logger), logger);
  });

  afterEach(async () => {
    await fs.promises.chmod(appDataDir, 0o755).catch(() => null);
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('is false when there is no folder', async () => {
    await expect(manager.hasAppData(appUrn)).resolves.toBe(false);
  });

  it('is false for an empty folder', async () => {
    await fs.promises.mkdir(appDataDir, { recursive: true });

    await expect(manager.hasAppData(appUrn)).resolves.toBe(false);
  });

  it('is true when the folder holds something', async () => {
    await fs.promises.mkdir(path.join(appDataDir, 'data'), { recursive: true });

    await expect(manager.hasAppData(appUrn)).resolves.toBe(true);
  });

  it.skipIf(!canEnforcePermissions)('is true for a folder the Hub cannot list, which may hold data', async () => {
    await fs.promises.mkdir(path.join(appDataDir, 'data'), { recursive: true });
    await fs.promises.chmod(appDataDir, 0o000);

    await expect(manager.hasAppData(appUrn)).resolves.toBe(true);
  });
});
