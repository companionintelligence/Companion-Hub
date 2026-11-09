import { describe, expect, it } from 'vitest';
import type { HardwareProfile } from '../../types/inference.js';
import { gpuRuntimeReady } from '../gpu-runtime.js';

const gpu = (overrides: Partial<HardwareProfile['gpu']>): HardwareProfile['gpu'] => ({
  available: true,
  vendor: 'amd',
  model: 'Radeon RX 7900 XTX',
  vramMb: 24_560,
  unifiedMemory: false,
  driverVersion: '',
  runtimeAvailable: false,
  ...overrides,
});

describe('gpuRuntimeReady', () => {
  it('is ready when the Hub container itself has the GPU runtime', () => {
    expect(gpuRuntimeReady(gpu({ runtimeAvailable: true }))).toBe(true);
  });

  it('is ready on an AMD box where only the host has /dev/kfd — the usual Linux layout', () => {
    expect(gpuRuntimeReady(gpu({ hostRocmKfdAvailable: true }))).toBe(true);
  });

  it('is not ready on an AMD box with ROCm installed but no /dev/kfd yet', () => {
    expect(gpuRuntimeReady(gpu({ hostRocmAvailable: true, hostRocmKfdAvailable: false }))).toBe(false);
  });

  it('is ready on an NVIDIA node whose host driver answers but has no container toolkit', () => {
    expect(gpuRuntimeReady(gpu({ vendor: 'nvidia', model: 'RTX A1000', hostNvidiaAvailable: true }))).toBe(true);
  });

  it('is not ready when neither the container nor the host vouches for the card', () => {
    expect(gpuRuntimeReady(gpu({ vendor: 'nvidia', hostNvidiaAvailable: false }))).toBe(false);
    expect(gpuRuntimeReady(gpu({ vendor: 'amd' }))).toBe(false);
  });

  it('has no host proof for other vendors, so only the container view counts', () => {
    expect(gpuRuntimeReady(gpu({ vendor: 'intel', hostRocmKfdAvailable: true, hostNvidiaAvailable: true }))).toBe(false);
  });
});
