import { describe, expect, it, vi } from 'vitest';
import { HardwareInspectorService } from '../../inference/hardware-inspector.service';
import { StatusReportService } from '../status-report.service';

/** The report as `buildReport` makes it for one GPU, with the real answer to "can inference reach it". */
async function reportFor(gpu: Record<string, unknown>) {
  const absent = new Proxy({}, { get: () => vi.fn().mockRejectedValue(new Error('not in this test')) });
  const hardware = {
    getProfile: vi.fn().mockResolvedValue({ tier: 'large', gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 102_912, ...gpu } }),
    gpuRuntimeReady: HardwareInspectorService.prototype.gpuRuntimeReady,
  };
  const systemInspector = { getSystemHealth: vi.fn().mockResolvedValue({}) };
  const service = new StatusReportService(
    { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
    absent as never,
    hardware as never,
    absent as never,
    absent as never,
    absent as never,
    systemInspector as never,
    absent as never,
  );
  return (await service.buildReport(new Date('2026-11-09T00:00:00.000Z'))).system?.gpu;
}

describe('the status report GPU line', () => {
  // The Hub container has no /dev/kfd on most hosts, and said "driver not responding" for a working card (#2291).
  it('calls an AMD driver working when the host probe proves it, though the container cannot see the card', async () => {
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: true })).toMatchObject({ driverWorking: true });
  });

  it('still reports an AMD card that neither the container nor the host can use', async () => {
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: false })).toMatchObject({ driverWorking: false });
  });

  it('still calls a driver working when the container can reach the card itself', async () => {
    expect(await reportFor({ runtimeAvailable: true })).toMatchObject({ driverWorking: true });
  });

  it('applies the same rule to NVIDIA', async () => {
    expect(await reportFor({ vendor: 'nvidia', runtimeAvailable: false, hostNvidiaAvailable: true })).toMatchObject({ driverWorking: true });
    expect(await reportFor({ vendor: 'nvidia', runtimeAvailable: false, hostNvidiaAvailable: false })).toMatchObject({ driverWorking: false });
  });
});
