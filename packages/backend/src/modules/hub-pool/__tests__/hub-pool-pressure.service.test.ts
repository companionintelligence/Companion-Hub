import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HardwareProfile } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { readAmdDrmOccupancy } from '../gpu-pressure-sources';

// The DRM reader is the one part that touches a real filesystem layout; `gpu-pressure-sources.test.ts`
// covers it against a temp dir. Here it is a seam, so these tests are about the sampler's own rules.
vi.mock('../gpu-pressure-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu-pressure-sources')>()),
  readAmdDrmOccupancy: vi.fn(),
}));

const SAMPLE_INTERVAL_MS = 10_000;

function amdProfile(overrides: Partial<HardwareProfile['gpu']> = {}): HardwareProfile {
  return {
    gpu: {
      available: true,
      vendor: 'amd',
      model: 'Radeon 8060S',
      vramMb: 65_536,
      unifiedMemory: true,
      driverVersion: '6.12',
      runtimeAvailable: true,
      ...overrides,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: 131_072, availableMb: 65_536 },
    cpu: { arch: 'x86_64', cores: 16, model: 'Ryzen AI Max 395' },
  } as HardwareProfile;
}

describe('HubPoolPressureService', () => {
  let logger: MockProxy<LoggerService>;
  let filesystem: MockProxy<FilesystemService>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let service: HubPoolPressureService;
  const drmSpy = vi.mocked(readAmdDrmOccupancy);

  /**
   * The band only exists to be compared with a peer's, so the sampler is armed by the health tick
   * when it sees one — not by module init, and not by a periodic query of its own.
   */
  function withConnectedPeer(): void {
    service.setPoolActive(true);
  }

  /** Drive N sampler ticks, each 10s apart, awaiting the async work each one starts. */
  async function tick(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    logger = mock<LoggerService>();
    filesystem = mock<FilesystemService>();
    hardwareInspector = mock<HardwareInspectorService>();

    // The fleet default everywhere below unless a test says otherwise: no host file, an AMD card.
    filesystem.readJsonFile.mockResolvedValue(null);
    hardwareInspector.getProfile.mockResolvedValue(amdProfile());
    drmSpy.mockReset();
    drmSpy.mockResolvedValue(null);

    service = new HubPoolPressureService(logger, filesystem, hardwareInspector);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  describe('the neutrality invariant', () => {
    it('reports null, never 0, when nothing could be measured', async () => {
      withConnectedPeer();

      await tick(5);

      // This is THE property of the feature. A node that cannot report pressure must never thereby
      // become the most attractive candidate, so "unmeasured" and "idle" cannot share an encoding.
      // Callers map null to UNKNOWN_PRESSURE (mid-band); a 0 here would map to "idle" and hand every
      // tie to whichever machine knows least about itself.
      expect(service.band()).toBeNull();
      expect(service.band()).not.toBe(0);
      expect(service.source()).toBeNull();
    });

    it('still reports null after exactly one sample, because one sample is a spike not a level', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.9);

      await tick(1);

      expect(service.band()).toBeNull();
    });

    it('ages back to null when sampling stops, rather than freezing at its last value', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.95);
      await tick(3);
      expect(service.band()).toBe(3);

      // A wedged source, a stalled loop, the last peer being unpaired: one age-out rule covers all
      // of them, and the value must decay to unmeasured rather than to 0.
      drmSpy.mockResolvedValue(null);
      await tick(4);

      expect(service.band()).toBeNull();
      expect(service.band()).not.toBe(0);
      expect(service.source()).toBeNull();
    });

    it('measures a genuinely idle card as band 0, which is a different claim from null', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0);

      await tick(3);

      expect(service.band()).toBe(0);
    });
  });

  describe('sampling cost on a peerless Hub', () => {
    it('arms no timer at all until a peer connects', async () => {
      // The cost this pins. The overwhelming majority of deployments are single-node, and the
      // previous shape armed a 10s self-rescheduling timer on every one of them that then ran an
      // indexed SELECT forever just to re-learn there was nobody to compare a band against.
      // `poolEnabled` DEFAULTS TRUE, so gating on it would have gated nothing.
      expect(service.isSampling()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does no source I/O at all while nothing is paired', async () => {
      await tick(6);

      expect(filesystem.readJsonFile).not.toHaveBeenCalled();
      expect(drmSpy).not.toHaveBeenCalled();
      expect(hardwareInspector.getProfile).not.toHaveBeenCalled();
      expect(service.band()).toBeNull();
    });

    it('starts sampling once a peer connects, with no restart', async () => {
      await tick(2);
      expect(drmSpy).not.toHaveBeenCalled();

      withConnectedPeer();
      drmSpy.mockResolvedValue(0.5);
      await tick(2);

      expect(service.isSampling()).toBe(true);
      expect(service.band()).toBe(1);
    });

    it('disarms again when the last peer goes away, and forgets the band it measured', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.95);
      await tick(3);
      expect(service.band()).toBe(3);

      service.setPoolActive(false);

      expect(service.isSampling()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // Not merely stale — cleared. A band carried over from the last time this node had a peer is a
      // claim about a GPU nobody has measured since.
      expect(service.band()).toBeNull();

      drmSpy.mockClear();
      await tick(6);
      expect(drmSpy).not.toHaveBeenCalled();
    });

    it('is idempotent, because the health tick calls it on every single poll', async () => {
      withConnectedPeer();
      withConnectedPeer();
      withConnectedPeer();

      expect(vi.getTimerCount()).toBe(1);
    });

    it('never calls rescan(), which would re-fork nvidia-smi and rocm-smi on a 10s loop', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.5);

      await tick(10);

      expect(hardwareInspector.rescan).not.toHaveBeenCalled();
    });

    it('reads the hardware profile once behind a long TTL, not once per tick', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.5);

      await tick(10);

      // getProfile() is not a cheap accessor: on an incomplete discrete-GPU profile it re-runs the
      // full detect(), forking nvidia-smi / rocm-smi / system_profiler behind 5s timeouts.
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(1);
    });
  });

  describe('AMD-only gating', () => {
    it('does not touch DRM sysfs on an NVIDIA node, which stays honestly unmeasured', async () => {
      withConnectedPeer();
      hardwareInspector.getProfile.mockResolvedValue(amdProfile({ vendor: 'nvidia', model: 'RTX 3080' }));

      await tick(3);

      expect(drmSpy).not.toHaveBeenCalled();
      expect(service.band()).toBeNull();
    });

    it('does not sample a CPU-only node', async () => {
      withConnectedPeer();
      hardwareInspector.getProfile.mockResolvedValue(amdProfile({ available: false, vendor: 'none', vramMb: 0 }));

      await tick(3);

      expect(drmSpy).not.toHaveBeenCalled();
      expect(service.band()).toBeNull();
    });

    it('degrades to unmeasured when hardware detection itself throws', async () => {
      withConnectedPeer();
      hardwareInspector.getProfile.mockRejectedValue(new Error('docker info timed out'));

      await tick(3);

      expect(service.band()).toBeNull();
    });
  });

  describe('the source ladder', () => {
    it('prefers the host file over DRM sysfs and names the source that answered', async () => {
      withConnectedPeer();
      filesystem.readJsonFile.mockResolvedValue({ schemaVersion: 1, sampledAt: new Date().toISOString(), busyPercent: 90 });
      drmSpy.mockResolvedValue(0.1);

      await tick(3);

      expect(service.band()).toBe(3);
      expect(service.source()).toBe('host-file');
    });

    it('falls through to DRM sysfs when the host file is absent', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.9);

      await tick(3);

      expect(service.source()).toBe('amd-drm');
    });

    it('falls through when the host file read throws', async () => {
      withConnectedPeer();
      filesystem.readJsonFile.mockRejectedValue(new Error('EACCES'));
      drmSpy.mockResolvedValue(0.9);

      await tick(3);

      expect(service.band()).toBe(3);
      expect(service.source()).toBe('amd-drm');
    });

    it('keeps the loop alive when a source throws, instead of freezing the band forever', async () => {
      withConnectedPeer();
      drmSpy.mockRejectedValue(new Error('sysfs went away'));
      await tick(3);
      expect(service.band()).toBeNull();

      drmSpy.mockResolvedValue(0.9);
      await tick(3);

      expect(service.band()).toBe(3);
    });

    it('ignores a stale host file rather than reading it as idle', async () => {
      withConnectedPeer();
      filesystem.readJsonFile.mockResolvedValue({
        schemaVersion: 1,
        sampledAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        busyPercent: 0,
      });
      drmSpy.mockResolvedValue(null);

      await tick(3);

      expect(service.band()).toBeNull();
    });
  });

  describe('smoothing and banding', () => {
    it('ramps across successive samples on a step change rather than following the raw signal', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0);
      await tick(3);
      expect(service.band()).toBe(0);

      drmSpy.mockResolvedValue(1);
      const climb: (number | null)[] = [];
      for (let i = 0; i < 4; i += 1) {
        await tick(1);
        climb.push(service.band());
      }

      // EWMA at alpha 0.4 from 0: 0.4, 0.64, 0.784, 0.8704. One spike cannot carry the band to 3,
      // which is the whole reason the raw sample is not published.
      expect(climb).toEqual([1, 1, 2, 3]);
    });

    it('may skip bands on the way up — a card that is already full is saturated now', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.86);

      // Two samples is the minimum for a band at all, and the first seeds the EWMA directly, so this
      // is the earliest the band can be published. It reads 3, not 1: making it climb one band per
      // 10s tick would mean half a minute of routing work onto a machine that is already full.
      await tick(2);

      expect(service.band()).toBe(3);
    });

    it('does not flap between 1 and 2 while occupancy oscillates across the boundary', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.72);
      await tick(20);
      expect(service.band()).toBe(2);

      const observed: (number | null)[] = [];
      for (let i = 0; i < 10; i += 1) {
        drmSpy.mockResolvedValue(i % 2 === 0 ? 0.68 : 0.72);
        await tick(1);
        observed.push(service.band());
      }

      // The 5-point deadband: leaving band 2 needs occupancy under 0.65, which 0.68 never reaches.
      // Without it every peer's ranking input would change every ten seconds.
      expect(new Set(observed)).toEqual(new Set([2]));
    });

    it('walks back down one band at a time', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(1);
      await tick(20);
      expect(service.band()).toBe(3);

      drmSpy.mockResolvedValue(0);
      const descent: (number | null)[] = [];
      for (let i = 0; i < 3; i += 1) {
        await tick(1);
        descent.push(service.band());
      }

      expect(descent).toEqual([2, 1, 0]);
    });
  });

  describe('lifecycle', () => {
    it('has no module-init hook to throw out of, and costs nothing until told there is a peer', () => {
      const fresh = new HubPoolPressureService(logger, filesystem, hardwareInspector);

      // A throw at boot crash-loops the whole appliance, peerless single-node Hubs included. There
      // is now nothing at boot at all: construction alone must not arm anything.
      expect(fresh.isSampling()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      fresh.onModuleDestroy();
    });

    it('refuses to re-arm after destruction, so a late health tick cannot resurrect the loop', async () => {
      service.onModuleDestroy();

      service.setPoolActive(true);

      expect(service.isSampling()).toBe(false);
      await tick(3);
      expect(drmSpy).not.toHaveBeenCalled();
    });

    it('stops sampling after onModuleDestroy', async () => {
      withConnectedPeer();
      drmSpy.mockResolvedValue(0.5);
      await tick(2);
      const callsBefore = drmSpy.mock.calls.length;

      service.onModuleDestroy();
      await tick(5);

      expect(drmSpy.mock.calls.length).toBe(callsBefore);
    });
  });
});
