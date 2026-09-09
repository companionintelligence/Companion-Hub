import { describe, expect, it } from 'vitest';

import { appInfoSchema, gpuRequirementsSchema } from '../app-info.js';

const baseApp = {
  id: 'gpu-app',
  urn: 'gpu-app:ci-marketplace',
  available: true,
  name: 'GPU app',
  short_desc: 'GPU app',
  author: 'Companion Intelligence',
  source: 'https://github.com/companionintelligence/gpu-app',
};

describe('gpuRequirementsSchema', () => {
  it('accepts CUDA metadata without host devices', () => {
    const result = gpuRequirementsSchema.safeParse({
      type: 'cuda',
      optional: false,
      host_platforms: ['linux', 'windows'],
      minimum_vram_gb: 8,
      recommended_vram_gb: 12,
    });

    expect(result.success).toBe(true);
  });

  it('accepts Linux-only ROCm metadata with a device', () => {
    const result = gpuRequirementsSchema.safeParse({
      type: 'rocm',
      optional: true,
      host_platforms: ['linux'],
      host_devices: ['/dev/kfd', '/dev/dri'],
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid accelerator/platform combinations and VRAM ranges', () => {
    expect(
      gpuRequirementsSchema.safeParse({
        type: 'cuda',
        optional: false,
        host_platforms: ['linux'],
        host_devices: ['/dev/nvidia0'],
      }).success,
    ).toBe(false);
    expect(
      gpuRequirementsSchema.safeParse({
        type: 'rocm',
        optional: false,
        host_platforms: ['linux', 'windows'],
        host_devices: ['/dev/kfd'],
      }).success,
    ).toBe(false);
    expect(
      gpuRequirementsSchema.safeParse({
        type: 'cuda',
        optional: false,
        host_platforms: ['linux'],
        minimum_vram_gb: 16,
        recommended_vram_gb: 8,
      }).success,
    ).toBe(false);
  });
});

describe('appInfoSchema GPU integration', () => {
  it('preserves the accelerator block instead of stripping it', () => {
    const parsed = appInfoSchema.parse({
      ...baseApp,
      gpu_requirements: {
        type: 'cuda',
        optional: false,
        host_platforms: ['linux', 'windows'],
        minimum_vram_gb: 8,
      },
    });

    expect(parsed.gpu_requirements).toMatchObject({ type: 'cuda', optional: false, minimum_vram_gb: 8 });
  });
});
