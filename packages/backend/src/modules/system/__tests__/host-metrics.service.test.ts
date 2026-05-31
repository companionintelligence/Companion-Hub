import { Test, TestingModule } from '@nestjs/testing';
import { HostMetricsService } from '../host-metrics.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { probeHostMetrics } from '../../../../../../scripts/init-host-probe';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import si from 'systeminformation';

vi.mock('systeminformation');

describe('HostMetricsService', () => {
  let service: HostMetricsService;
  let filesystemService: MockProxy<FilesystemService>;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    filesystemService = mock<FilesystemService>();
    loggerService = mock<LoggerService>();

    (si.fsSize as any) = vi.fn().mockResolvedValue([{ available: 50 * 1024 * 1024 * 1024, size: 100 * 1024 * 1024 * 1024 }]);
    (si.mem as any) = vi.fn().mockResolvedValue({
      total: 8 * 1024 * 1024 * 1024,
      available: 4 * 1024 * 1024 * 1024,
    });
    (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 8, brand: 'Test CPU', manufacturer: 'Test' });
    (si.fsSize as any) = vi.fn().mockResolvedValue([{ available: 50 * 1024 * 1024 * 1024, size: 100 * 1024 * 1024 * 1024, mount: '/' }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostMetricsService,
        { provide: FilesystemService, useValue: filesystemService },
        { provide: LoggerService, useValue: loggerService },
      ],
    }).compile();

    service = module.get<HostMetricsService>(HostMetricsService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.CI_HUB_IN_DOCKER;
  });

  const hostProbeJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      platform: 'darwin',
      cpuArch: 'arm64',
      source: 'init-host-probe',
      probedAt: '2026-01-01T00:00:00.000Z',
      host: {
        totalRamMb: 32768,
        availableRamMb: 16384,
        cpuCores: 12,
        cpuModel: 'Apple M2 Pro',
        diskTotalGb: 494,
        diskUsedGb: 477,
        diskMount: '/',
      },
      ...overrides,
    });

  describe('detectRuntimeKind', () => {
    it('detects docker-desktop-vm when host RAM exceeds container RAM', () => {
      const kind = service.detectRuntimeKind(JSON.parse(hostProbeJson()) as any, {
        totalRamMb: 8192,
        availableRamMb: 4096,
        diskTotalGb: 452,
        diskUsedGb: 40,
        memoryTotalGb: 8,
      });
      expect(kind).toBe('docker-desktop-vm');
    });

    it('detects wsl2-vm on Windows host probe', () => {
      const probe = JSON.parse(hostProbeJson({ platform: 'win32', cpuArch: 'x86_64' })) as any;
      const kind = service.detectRuntimeKind(probe, {
        totalRamMb: 8192,
        availableRamMb: 4096,
        diskTotalGb: 256,
        diskUsedGb: 120,
        memoryTotalGb: 8,
      });
      expect(kind).toBe('wsl2-vm');
    });

    it('detects linux-native when host and container RAM are similar', () => {
      const probe = JSON.parse(hostProbeJson({ platform: 'linux', cpuArch: 'x86_64' })) as any;
      probe.host.totalRamMb = 16384;
      const kind = service.detectRuntimeKind(probe, {
        totalRamMb: 16000,
        availableRamMb: 8000,
        diskTotalGb: 500,
        diskUsedGb: 200,
        memoryTotalGb: 16,
      });
      expect(kind).toBe('linux-native');
    });

    it('returns container-only when probe is missing', () => {
      const kind = service.detectRuntimeKind(null, {
        totalRamMb: 8192,
        availableRamMb: 4096,
        diskTotalGb: 100,
        diskUsedGb: 50,
        memoryTotalGb: 8,
      });
      expect(kind).toBe('container-only');
    });
  });

  describe('getDisplayLoad', () => {
    it('uses host totals when probe exists and exposes VM wedge overlay', async () => {
      filesystemService.readTextFile.mockImplementation(async (path: string) => {
        if (path === '/data/state/hardware/host_metrics.json') return hostProbeJson();
        if (path === '/host/proc/meminfo') return 'MemTotal: 8388608\nMemAvailable: 4194304';
        return null;
      });

      const load = await service.getDisplayLoad(12.5, 8);

      expect(load.memoryTotal).toBe(32);
      expect(load.memoryUsed).toBe(16);
      expect(load.diskSize).toBe(494);
      expect(load.diskUsed).toBe(477);
      expect(load.cpuCores).toBe(12);
      expect(load.hasVmWedge).toBe(true);
      expect(load.containerMemoryTotal).toBe(8);
      expect(load.recommendedDockerRamMb).toBeGreaterThanOrEqual(8192);
    });

    it('falls back to legacy host_system.json when host_metrics.json is absent', async () => {
      filesystemService.readTextFile.mockImplementation(async (path: string) => {
        if (path === '/data/state/hardware/host_system.json') {
          return JSON.stringify({
            platform: 'darwin',
            cpuArch: 'arm64',
            cpuModel: 'Apple M2 Ultra',
            cpuCores: 24,
            totalRamMb: 98304,
            availableRamMb: 83558,
            isAppleSilicon: true,
          });
        }
        if (path === '/host/proc/meminfo') return 'MemTotal: 8388608\nMemAvailable: 4194304';
        return null;
      });

      const load = await service.getDisplayLoad(5, 8);
      expect(load.memoryTotal).toBe(96);
      expect(load.hasVmWedge).toBe(true);
    });

    it('uses container metrics when no probe exists', async () => {
      filesystemService.readTextFile.mockResolvedValue(null);

      const load = await service.getDisplayLoad(20, 4);

      expect(load.memoryTotal).toBe(8);
      expect(load.diskSize).toBe(100);
      expect(load.hasVmWedge).toBe(false);
      expect(load.runtimeKind).toBe('container-only');
    });
  });

  describe('init-host-probe script', () => {
    it('probeHostMetrics returns schemaVersion 1 with host section', async () => {
      const probe = await probeHostMetrics();

      expect(probe.schemaVersion).toBe(1);
      expect(probe.source).toBe('init-host-probe');
      expect(probe.host.totalRamMb).toBeGreaterThan(0);
      expect(probe.host.cpuCores).toBeGreaterThan(0);
    });
  });
});
