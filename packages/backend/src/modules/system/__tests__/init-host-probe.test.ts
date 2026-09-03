import { describe, it, expect, vi, afterEach } from 'vitest';
import si from 'systeminformation';
import { probeHostMetrics } from '../../../../../../scripts/init-host-probe';

vi.mock('systeminformation');

const GB = 1024 * 1024 * 1024;

/**
 * Regression coverage for the win32 branch of pickPrimaryFilesystem. The
 * systeminformation types mark FsSizeData.fs/mount as required, but real Windows
 * hosts can report volumes with those fields missing. The probe must degrade
 * gracefully instead of crashing the whole pre-start host probe.
 */
describe('init-host-probe pickPrimaryFilesystem robustness', () => {
  const originalPlatform = process.platform;

  const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.clearAllMocks();
  });

  it('does not crash on win32 when a filesystem entry omits fs/mount', async () => {
    setPlatform('win32');

    (si.mem as any) = vi.fn().mockResolvedValue({ total: 8 * GB, available: 4 * GB });
    (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 8, brand: 'Test CPU', manufacturer: 'Test' });
    // Sparse entry: `fs` and `mount` are absent. The pre-hardening win32 branch did
    // `entry.fs.toUpperCase()` and threw TypeError on exactly this shape.
    (si.fsSize as any) = vi.fn().mockResolvedValue([{ size: 100 * GB, available: 50 * GB }]);

    const probe = await probeHostMetrics();

    expect(probe.schemaVersion).toBe(1);
    expect(probe.platform).toBe('win32');
    expect(probe.host.totalRamMb).toBeGreaterThan(0);
    // Falls back to the first filesystem for size, and to the win32 default for mount.
    expect(probe.host.diskTotalGb).toBe(100);
    expect(probe.host.diskMount).toBe('C:');
  });

  it('still selects the C: volume on win32 when fs/mount are present', async () => {
    setPlatform('win32');

    (si.mem as any) = vi.fn().mockResolvedValue({ total: 8 * GB, available: 4 * GB });
    (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 8, brand: 'Test CPU', manufacturer: 'Test' });
    (si.fsSize as any) = vi.fn().mockResolvedValue([
      { fs: 'D:', type: 'NTFS', size: 500 * GB, used: 10 * GB, available: 490 * GB, use: 2, mount: 'D:', rw: true },
      { fs: 'C:', type: 'NTFS', size: 100 * GB, used: 60 * GB, available: 40 * GB, use: 60, mount: 'C:', rw: true },
    ]);

    const probe = await probeHostMetrics();

    expect(probe.host.diskMount).toBe('C:');
    expect(probe.host.diskTotalGb).toBe(100);
  });
});
