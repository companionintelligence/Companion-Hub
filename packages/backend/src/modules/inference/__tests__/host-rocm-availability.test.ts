import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { isHostRocmStackAvailable, isRocmKfdPassthroughAvailable, readRocmHostProbe, ROCM_HOST_PROBE_PATH } from '../host-rocm-availability';

vi.mock('@/common/helpers/container-paths', () => ({
  resolveContainerDataPath: (filePath: string) => filePath,
}));

describe('host-rocm-availability', () => {
  beforeEach(() => {
    vi.spyOn(fs.promises, 'readFile');
    vi.spyOn(fs.promises, 'access');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads host probe metadata', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ available: true, source: 'host-dev-kfd' }) as unknown as Buffer);

    await expect(readRocmHostProbe()).resolves.toEqual({ available: true, source: 'host-dev-kfd' });
    expect(fs.promises.readFile).toHaveBeenCalledWith(ROCM_HOST_PROBE_PATH, 'utf8');
  });

  it('treats host-dev-kfd probe as passthrough-ready without container /dev/kfd', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ available: true, source: 'host-dev-kfd' }) as unknown as Buffer);
    vi.mocked(fs.promises.access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(isRocmKfdPassthroughAvailable()).resolves.toBe(true);
  });

  it('does not treat rocm-smi-only probe as passthrough-ready', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ available: true, source: 'host-rocm-smi' }) as unknown as Buffer);
    vi.mocked(fs.promises.access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(isRocmKfdPassthroughAvailable()).resolves.toBe(false);
    await expect(isHostRocmStackAvailable()).resolves.toBe(true);
  });

  it('falls back to runtime /dev/kfd when probe cache is missing', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);

    await expect(isRocmKfdPassthroughAvailable()).resolves.toBe(true);
  });
});
