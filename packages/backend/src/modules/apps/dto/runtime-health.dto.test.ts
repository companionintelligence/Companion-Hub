import { describe, expect, it } from 'vitest';
import { AppRuntimeHealthDto, AppRuntimeMonitorDto } from './runtime-health.dto';

const completedJobSnapshot = {
  appUrn: 'ci-memory:ci-marketplace',
  appName: 'ci-memory',
  status: 'running',
  cpuPercent: 0,
  memoryUsageBytes: 0,
  memoryLimitBytes: 0,
  highCpu: false,
  sustainedHighCpu: false,
  responsive: true,
  degraded: false,
  forceStopEligible: false,
  reason: null,
  cpuLimit: null,
  usesDefaultCpuLimit: false,
  sampledAt: '2026-09-04T19:00:00.000Z',
  containers: [
    {
      containerId: 'setup',
      name: 'ci-memory_ci-marketplace-setup-secrets-1',
      state: 'exited',
      status: 'Exited (0) 9 minutes ago',
      health: null,
      exitCode: 0,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
    },
  ],
  gpuVramMb: null,
};

describe('runtime health DTOs', () => {
  it('preserves a completed container exit code in the app response', () => {
    const parsed = AppRuntimeHealthDto.parse(completedJobSnapshot);

    expect(parsed.containers[0]?.exitCode).toBe(0);
  });

  it('preserves container exit codes in the aggregate monitor response', () => {
    const parsed = AppRuntimeMonitorDto.parse({
      sampledAt: completedJobSnapshot.sampledAt,
      apps: [completedJobSnapshot],
      history: [],
      unattributedGpu: null,
      gpuVramSource: 'absent',
    });

    expect(parsed.apps[0]?.containers[0]?.exitCode).toBe(0);
  });

  it('carries the GPU sample source as an enum, with absent distinct from the empty-snapshot null', () => {
    const base = { sampledAt: completedJobSnapshot.sampledAt, apps: [], history: [], unattributedGpu: null };
    for (const gpuVramSource of ['host-file', 'tool', 'absent', null] as const) {
      expect(AppRuntimeMonitorDto.parse({ ...base, gpuVramSource }).gpuVramSource).toBe(gpuVramSource);
    }
    // A source this build does not know is refused rather than passed through as if it were one.
    expect(() => AppRuntimeMonitorDto.parse({ ...base, gpuVramSource: 'guessed' })).toThrow();
  });
});
