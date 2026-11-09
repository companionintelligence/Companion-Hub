import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { HardwareInspectorService } from '../../inference/hardware-inspector.service';
import { ROCM_HOST_PROBE_PATH } from '../../inference/host-rocm-availability';
import { StatusReportService } from '../status-report.service';

/** What `cihub up` leaves behind on a Linux host: the probe's own view of `/dev/kfd`. */
async function writeRocmProbe(content: string) {
  await fs.promises.mkdir(path.dirname(ROCM_HOST_PROBE_PATH), { recursive: true });
  await fs.promises.writeFile(ROCM_HOST_PROBE_PATH, content);
}

function rocmProbe(available: boolean, updatedAt: string = new Date().toISOString()) {
  return JSON.stringify({ available, source: 'host-dev-kfd', updatedAt });
}

/** The report as `buildReport` makes it for one GPU, with the real answer to "can inference reach it". */
async function reportFor(gpu: Record<string, unknown>) {
  const absent = new Proxy({}, { get: () => vi.fn().mockRejectedValue(new Error('not in this test')) });
  const logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
  const hardware = new HardwareInspectorService(logger, new FilesystemService(logger), absent as never);
  vi.spyOn(hardware, 'getProfile').mockResolvedValue({
    tier: 'large',
    gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 102_912, ...gpu },
  } as never);
  const systemInspector = { getSystemHealth: vi.fn().mockResolvedValue({}) };
  const service = new StatusReportService(
    logger,
    absent as never,
    hardware,
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

  it('still reports an AMD card that neither the container nor the host probe can find', async () => {
    await writeRocmProbe(rocmProbe(false));
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: false })).toMatchObject({ driverWorking: false });
  });

  // The profile is cached, and `cihub up` rewrites the probe under a Hub that keeps running.
  it('believes a host probe that now finds the card over a profile cached before it', async () => {
    await writeRocmProbe(rocmProbe(true));
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: false })).toMatchObject({ driverWorking: true });
  });

  // Docker restarts the Hub after a reboot without running the probe again.
  it('does not call an AMD driver broken on a probe from before the last reboot', async () => {
    await writeRocmProbe(rocmProbe(false, '2020-01-01T00:00:00.000Z'));
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: false })).toMatchObject({ driverWorking: true });
  });

  it('does not call an AMD driver broken under WSL 2, where no card gets a /dev/kfd', async () => {
    await writeRocmProbe(rocmProbe(false));
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: false, containerHostKind: 'wsl-engine' })).toMatchObject({
      driverWorking: true,
    });
  });

  // Only Linux writes rocm.json, so on Windows and macOS there is nothing to read.
  it('does not call an AMD driver broken when the host probe never ran', async () => {
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: false })).toMatchObject({ driverWorking: true });
  });

  it('does not call an AMD driver broken when the host probe cannot be parsed', async () => {
    await writeRocmProbe('{not json');
    expect(await reportFor({ runtimeAvailable: false, hostRocmKfdAvailable: false })).toMatchObject({ driverWorking: true });
  });

  // `runtimeAvailable` is the AMD /dev/kfd test for every vendor but NVIDIA, so it is always false on Intel.
  it('does not call an Intel driver broken, because nothing checks one', async () => {
    expect(await reportFor({ vendor: 'intel', model: 'UHD Graphics 770', runtimeAvailable: false })).toMatchObject({ driverWorking: true });
  });

  it('still calls a driver working when the container can reach the card itself', async () => {
    expect(await reportFor({ runtimeAvailable: true })).toMatchObject({ driverWorking: true });
  });

  it('applies the same rule to NVIDIA', async () => {
    expect(await reportFor({ vendor: 'nvidia', runtimeAvailable: false, hostNvidiaAvailable: true })).toMatchObject({ driverWorking: true });
    expect(await reportFor({ vendor: 'nvidia', runtimeAvailable: false, hostNvidiaAvailable: false })).toMatchObject({ driverWorking: false });
  });
});
