import type { HardwareProfile } from '@ci-hub/common/types';
import { describe, expect, it, vi } from 'vitest';
import type { HardwareInspectorService } from '../../inference/hardware-inspector.service';
import type { SystemInspectorService } from '../../system/system-inspector.service';
import { renderHubStatusMarkdown } from '../status-report.render';
import { StatusReportService } from '../status-report.service';

/** The GPU line of the report `buildReport` writes for one card. The other sections fail and are skipped. */
async function gpuLine(gpu: Partial<HardwareProfile['gpu']>): Promise<string | undefined> {
  const unread = new Proxy({}, { get: () => vi.fn().mockRejectedValue(new Error('not in this test')) });
  const logger = { warn: vi.fn() };
  const profile = {
    tier: 'cpu-only',
    gpu: {
      available: true,
      vendor: 'intel',
      model: 'UHD Graphics 770',
      vramMb: 0,
      unifiedMemory: false,
      driverVersion: '',
      runtimeAvailable: false,
      ...gpu,
    },
  };
  const hardware: Pick<HardwareInspectorService, 'getProfile'> = { getProfile: vi.fn().mockResolvedValue(profile) };
  const systemInspector: Pick<SystemInspectorService, 'getSystemHealth'> = { getSystemHealth: vi.fn().mockResolvedValue({}) };
  const service = new StatusReportService(
    logger as never,
    unread as never,
    hardware as never,
    unread as never,
    unread as never,
    unread as never,
    systemInspector as never,
    unread as never,
  );
  const markdown = renderHubStatusMarkdown(await service.buildReport(new Date('2026-11-10T00:00:00.000Z')));
  return markdown.split('\n').find((line) => line.startsWith('| GPU |'));
}

describe('the status report GPU line', () => {
  // `runtimeAvailable` is the ROCm /dev/kfd test on an Intel card and nothing else checks its driver,
  // so every Intel machine used to read "driver not responding" (#2410).
  it('makes no claim about an Intel driver, which nothing checks', async () => {
    expect(await gpuLine({})).toBe('| GPU | intel UHD Graphics 770, 0.0 GiB VRAM |');
    expect(await gpuLine({ model: 'Arc A770', vramMb: 16_384 })).toBe('| GPU | intel Arc A770, 16.0 GiB VRAM |');
  });

  it('still judges AMD and NVIDIA by the container or the host probes', async () => {
    const amd = { vendor: 'amd' as const, model: 'Radeon 8060S', vramMb: 1024 };
    expect(await gpuLine({ ...amd, hostRocmKfdAvailable: true })).toBe(
      '| GPU | amd Radeon 8060S, 1.0 GiB VRAM (driven by the host; not visible inside the Hub container) |',
    );
    expect(await gpuLine({ ...amd, hostRocmKfdAvailable: false })).toContain('**driver not responding**');
    const nvidia = { vendor: 'nvidia' as const, model: 'RTX 3080', vramMb: 10_240 };
    expect(await gpuLine({ ...nvidia, runtimeAvailable: true })).toBe('| GPU | nvidia RTX 3080, 10.0 GiB VRAM |');
    expect(await gpuLine({ ...nvidia, hostNvidiaAvailable: false })).toContain('**driver not responding**');
  });
});
