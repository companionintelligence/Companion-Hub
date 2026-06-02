import { describe, expect, it } from 'vitest';
import type { HardwareProfile } from '@ci-hub/common/types';
import { isAmdApu, resolveTierBadge, resolveVramDisplay } from './hardware-display';

function makeHardware(overrides: Partial<HardwareProfile['gpu']> = {}, ramTotalMb = 125_000): HardwareProfile {
  return {
    gpu: {
      available: true,
      vendor: 'amd',
      model: 'Radeon 8060S',
      vramMb: ramTotalMb,
      unifiedMemory: true,
      driverVersion: '',
      runtimeAvailable: false,
      ...overrides,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: ramTotalMb, availableMb: 115_000 },
    cpu: { arch: 'x86_64', cores: 32, model: 'RYZEN AI MAX+ 395 w/ Radeon 8060S' },
    effectiveInferenceMemoryMb: ramTotalMb,
    tier: 'high',
  };
}

describe('hardware-display', () => {
  it('labels AMD unified-memory systems as APU', () => {
    const hardware = makeHardware();
    expect(isAmdApu(hardware)).toBe(true);
    expect(resolveTierBadge('high', hardware).label).toBe('APU');
  });

  it('shows shared RAM as VRAM for APUs', () => {
    const hardware = makeHardware();
    const vram = resolveVramDisplay(hardware);
    expect(vram.value).toBe('122.1 GB');
    expect(vram.sub).toBe('Shared · APU');
  });
});
