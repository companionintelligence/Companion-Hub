import { describe, expect, it } from 'vitest';
import type { HardwareProfile } from '@ci-hub/common/types';
import { embedderRunsOnCpu } from '../embedder-placement';

const gpu = (overrides: Partial<HardwareProfile['gpu']>): Pick<HardwareProfile, 'gpu'> =>
  ({
    gpu: { available: true, vendor: 'amd', model: 'x', vramMb: 24576, unifiedMemory: false, driverVersion: '', runtimeAvailable: true, ...overrides },
  }) as never;

describe('embedderRunsOnCpu', () => {
  it('keeps the embedder off the GPU on an AMD ROCm host, discrete or unified (7900 XTX, Strix Halo alike)', () => {
    expect(embedderRunsOnCpu(gpu({}))).toBe(true);
    expect(embedderRunsOnCpu(gpu({ unifiedMemory: true, hostRocmAvailable: true }))).toBe(true);
    // An older profile that never probed the host stack still says AMD; the rule errs on the quiet side.
    expect(embedderRunsOnCpu(gpu({ hostRocmAvailable: undefined }))).toBe(true);
  });

  it('leaves it on the GPU everywhere else', () => {
    expect(embedderRunsOnCpu(gpu({ vendor: 'nvidia' }))).toBe(false);
    expect(embedderRunsOnCpu(gpu({ vendor: 'apple', unifiedMemory: true }))).toBe(false);
    expect(embedderRunsOnCpu(gpu({ available: false, vendor: 'none' }))).toBe(false);
    // AMD with no ROCm stack at all: Lemonade is on Vulkan, which the MES bug does not touch.
    expect(embedderRunsOnCpu(gpu({ hostRocmAvailable: false }))).toBe(false);
  });
});
