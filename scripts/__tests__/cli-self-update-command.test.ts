/**
 * Where `cihub self-update` puts the asset it downloads.
 *
 * `downloadReleaseAsset` defaults to one shared folder under the system temp dir and uses a file
 * already there as it is. With no token needed, any account on the machine could leave a binary in
 * that folder for `cihub self-update` to run (as its version probe) and install. The command now
 * downloads into a folder of its own that only this user can open, and removes it afterwards.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  downloadReleaseAsset: vi.fn(),
  installBinaryOverSelf: vi.fn(),
}));

vi.mock('../lib/fleet-cihub-binary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-cihub-binary.js')>()),
  downloadReleaseAsset: mocks.downloadReleaseAsset,
}));
vi.mock('../lib/cli-self-update.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-self-update.js')>()),
  installBinaryOverSelf: mocks.installBinaryOverSelf,
}));
vi.mock('../lib/cli-version-skew.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-version-skew.js')>()),
  classifyCliInstall: () => ({ kind: 'standalone', path: '/usr/local/bin/cihub' }),
}));
vi.mock('../lib/cli-ui.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-ui.js')>()),
  printMessageBox: vi.fn(),
}));

const { runSelfUpdateCommand } = await import('../lib/cli-update.js');

type Snapshot = NonNullable<Parameters<typeof runSelfUpdateCommand>[1]>;
const snapshot = { stack: { version: '0.3.6' } } as unknown as Snapshot;

describe.skipIf(process.platform === 'win32')('cihub self-update download folder', () => {
  let seenCacheDir: string | undefined;

  beforeEach(() => {
    seenCacheDir = undefined;
    process.exitCode = undefined;
    mocks.installBinaryOverSelf.mockReset().mockReturnValue({ ok: true, installedVersion: '0.3.6', message: 'replaced' });
    mocks.downloadReleaseAsset.mockReset().mockImplementation(async (input: { cacheDir?: string; assetName: string }) => {
      seenCacheDir = input.cacheDir;
      const assetPath = path.join(input.cacheDir as string, `v0.3.6-${input.assetName}`);
      writeFileSync(assetPath, 'downloaded-bytes');
      return { path: assetPath, tag: 'v0.3.6', sha256: 'x' };
    });
  });

  it('downloads into a new folder only this user can open, installs from it and removes it', async () => {
    await runSelfUpdateCommand([], snapshot);

    expect(seenCacheDir).toBeDefined();
    const cacheDir = seenCacheDir as string;
    expect(path.dirname(cacheDir)).toBe(tmpdir());
    expect(path.basename(cacheDir)).toMatch(/^cihub-self-update-/);
    expect(mocks.installBinaryOverSelf).toHaveBeenCalledWith(expect.objectContaining({ sourceBytes: Buffer.from('downloaded-bytes') }));
    expect(existsSync(cacheDir)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('creates that folder at 0700', async () => {
    let mode: number | undefined;
    mocks.downloadReleaseAsset.mockImplementationOnce(async (input: { cacheDir?: string }) => {
      mode = statSync(input.cacheDir as string).mode & 0o777;
      throw new Error('stop here');
    });

    await runSelfUpdateCommand([], snapshot);

    expect(mode).toBe(0o700);
  });

  it('removes the folder when the download fails, and installs nothing', async () => {
    mocks.downloadReleaseAsset.mockImplementationOnce(async (input: { cacheDir?: string }) => {
      seenCacheDir = input.cacheDir;
      throw new Error('asset download failed: HTTP 502 for cihub-linux-x64');
    });

    await runSelfUpdateCommand([], snapshot);

    expect(existsSync(seenCacheDir as string)).toBe(false);
    expect(mocks.installBinaryOverSelf).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
