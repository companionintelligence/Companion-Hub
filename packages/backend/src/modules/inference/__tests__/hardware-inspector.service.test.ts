import { Test, type TestingModule } from '@nestjs/testing';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import si from 'systeminformation';

const { execAsyncMock, archOverride } = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
  // null = use the real arch. Set to 'arm64'/'x64' to pin the host architecture for a test, so the
  // native-Apple-Silicon path is exercised on an Intel/Linux CI runner too.
  archOverride: { value: null as string | null },
}));

vi.mock('systeminformation');
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const patched = { ...actual, arch: () => archOverride.value ?? actual.arch() };
  return { ...patched, default: patched };
});
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return {
    ...actual,
    promisify: () => execAsyncMock,
  };
});

describe('HardwareInspectorService', () => {
  let service: HardwareInspectorService;
  let hostMetricsService: HostMetricsService;
  let loggerService: MockProxy<LoggerService>;
  let filesystemService: MockProxy<FilesystemService>;
  const originalHostPlatform = process.env.CI_HUB_HOST_PLATFORM;

  beforeEach(async () => {
    execAsyncMock.mockResolvedValue({ stdout: '{}' });

    loggerService = mock<LoggerService>();
    filesystemService = mock<FilesystemService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HardwareInspectorService,
        HostMetricsService,
        { provide: LoggerService, useValue: loggerService },
        { provide: FilesystemService, useValue: filesystemService },
      ],
    }).compile();

    service = module.get<HardwareInspectorService>(HardwareInspectorService);
    hostMetricsService = module.get<HostMetricsService>(HostMetricsService);
  });

  afterEach(() => {
    process.env.CI_HUB_HOST_PLATFORM = originalHostPlatform;
    archOverride.value = null;
    vi.clearAllMocks();
  });

  // ─── S-HW-1: GPU Detection ─────────────────────────────────────────

  describe('GPU detection (HW-1)', () => {
    beforeEach(() => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
    });

    it('S-HW-1.1: SHALL detect GPU vendor, model, and VRAM', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'RTX 4090', vram: 24576, driverVersion: '535.129.03' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.model).toBe('RTX 4090');
      expect(profile.gpu.vramMb).toBe(24576);
    });

    it('S-HW-1.2: SHALL set gpu.available=false when no GPU detected', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 4, brand: 'Intel i5' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 16777216\nMemAvailable: 8388608');

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(false);
      expect(profile.gpu.vendor).toBe('none');
    });

    it('SHALL infer AMD APU from Ryzen AI CPU model when container GPU detection fails', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 32, brand: 'RYZEN AI MAX+ 395 w/ Radeon 8060S' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 125829120\nMemAvailable: 115343360');
      filesystemService.pathExists.mockResolvedValue(false);

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.model).toContain('8060S');
      expect(profile.gpu.unifiedMemory).toBe(true);
      expect(profile.gpu.vramMb).toBe(122880);
      expect(profile.tier).toBe('high');
    });

    it('S-HW-1.2: SHALL set gpu.vendor to none when no GPU detected', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [{ vendor: '', model: '', vram: 0 }] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 4, brand: 'Intel' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 16777216\nMemAvailable: 8388608');

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('none');
      expect(profile.gpu.available).toBe(false);
    });

    it('SHALL prefer discrete NVIDIA GPU when multiple controllers are reported', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [
          { vendor: 'Intel', model: 'Intel UHD Graphics', vram: 128, driverVersion: '1.0' },
          { vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 4090', vram: 24564, driverVersion: '535.129.03' },
        ],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.model).toContain('RTX 4090');
      expect(profile.gpu.vramMb).toBe(24564);
    });

    it('SHALL correct WMI-capped VRAM (4095 MB) for >4 GB NVIDIA cards via nvidia-smi', async () => {
      // On Windows, systeminformation reads VRAM from WMI AdapterRAM (32-bit, saturates at 4095 MB),
      // so an 8 GB RTX 3080 Laptop GPU reports ~4 GB — 1 MB under the 4096 MB tier threshold.
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 3080 Laptop GPU', vram: 4095, driverVersion: '581.80' }],
      });
      process.env.CI_HUB_HOST_PLATFORM = 'win32';
      vi.spyOn(service as any, 'detectDockerInfo').mockResolvedValue({ nvidiaRuntime: true, containerHostKind: 'native-linux' });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          return { stdout: 'NVIDIA GeForce RTX 3080 Laptop GPU, 8192, 581.80\n' };
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'Intel Core i9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.vramMb).toBe(8192);
      expect(profile.tier).toBe('medium');
    });

    it('SHALL select the most capable NVIDIA GPU as a unit when correcting WMI-capped readings', async () => {
      // Multi-GPU Windows host: both controllers are WMI-capped to 4095 MB so they tie, and SI happens
      // to surface the lower-end card. The corrected VRAM and the reported model must come from the
      // same (most capable) GPU rather than pairing the 4090's VRAM with the 3060's name.
      process.env.CI_HUB_HOST_PLATFORM = 'win32';
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 3060', vram: 4095, driverVersion: '581.80' }],
      });
      vi.spyOn(service as any, 'detectDockerInfo').mockResolvedValue({ nvidiaRuntime: true, containerHostKind: 'native-linux' });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          return { stdout: 'NVIDIA GeForce RTX 3060, 8192, 581.80\nNVIDIA GeForce RTX 4090, 24564, 581.80\n' };
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'Intel Core i9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vramMb).toBe(24564);
      expect(profile.gpu.model).toBe('NVIDIA GeForce RTX 4090');
      expect(profile.tier).toBe('high');
    });

    it('SHALL keep the systeminformation VRAM when it already exceeds the nvidia-smi reading', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'RTX 4090', vram: 24576, driverVersion: '535.129.03' }],
      });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          return { stdout: 'NVIDIA GeForce RTX 4090, 24564, 535.129.03\n' };
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vramMb).toBe(24576);
    });

    it('SHALL NOT spawn nvidia-smi when systeminformation reports a plausible NVIDIA VRAM', async () => {
      // A plausible reading (not sub-512 MB, not in the Windows WMI cap band) is trusted as-is, so the
      // 5s-timeout nvidia-smi call is skipped on the common path — even on Windows.
      process.env.CI_HUB_HOST_PLATFORM = 'win32';
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 3070', vram: 8192, driverVersion: '535.129.03' }],
      });
      vi.spyOn(service as any, 'detectDockerInfo').mockResolvedValue({ nvidiaRuntime: true, containerHostKind: 'native-linux' });
      const smiSpy = vi.spyOn(service as any, 'detectLargestNvidiaGpuViaSmi');
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vramMb).toBe(8192);
      expect(profile.tier).toBe('medium');
      expect(smiSpy).not.toHaveBeenCalled();
    });

    it('SHALL clamp a WMI-capped reading to the 4 GB floor when nvidia-smi cannot recover the true VRAM', async () => {
      // Windows host: SI reports the capped 4095 MB and nvidia-smi is unavailable. The field saturated,
      // so the card has >=4 GB — it must degrade to `low`, not be mislabeled cpu-only at the threshold.
      process.env.CI_HUB_HOST_PLATFORM = 'win32';
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 3080 Laptop GPU', vram: 4095, driverVersion: '581.80' }],
      });
      vi.spyOn(service as any, 'detectDockerInfo').mockResolvedValue({ nvidiaRuntime: true, containerHostKind: 'native-linux' });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          throw new Error('nvidia-smi missing');
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'Intel Core i9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.model).toBe('NVIDIA GeForce RTX 3080 Laptop GPU');
      expect(profile.gpu.vramMb).toBe(4096);
      expect(profile.tier).toBe('low');
    });

    it('SHALL trust a 4096 MB Windows reading as a real 4 GB GPU without cross-checking', async () => {
      // NVIDIA saturates the WMI cap at 4095 MB, so a 4096 MB reading comes from the reliable 64-bit
      // registry path (a genuine 4 GB card) and must not trigger the nvidia-smi cross-check.
      process.env.CI_HUB_HOST_PLATFORM = 'win32';
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce GTX 1650', vram: 4096, driverVersion: '581.80' }],
      });
      vi.spyOn(service as any, 'detectDockerInfo').mockResolvedValue({ nvidiaRuntime: true, containerHostKind: 'native-linux' });
      const smiSpy = vi.spyOn(service as any, 'detectLargestNvidiaGpuViaSmi');
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'Intel Core i9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vramMb).toBe(4096);
      expect(profile.tier).toBe('low');
      expect(smiSpy).not.toHaveBeenCalled();
    });

    it('SHALL fallback to nvidia-smi when systeminformation omits controllers', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          return { stdout: 'NVIDIA GeForce RTX 4090, 24564, 550.54.14\n' };
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.model).toBe('NVIDIA GeForce RTX 4090');
      expect(profile.gpu.vramMb).toBe(24564);
      expect(profile.gpu.driverVersion).toBe('550.54.14');
    });

    it('SHALL fallback to /proc/driver/nvidia when nvidia-smi is unavailable', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Intel', model: 'Intel UHD Graphics', vram: 128, driverVersion: '1.0' }],
      });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/host/proc/meminfo') {
          return 'MemTotal: 67108864\nMemAvailable: 50331648';
        }
        if (filePath === '/data/state/hardware/nvidia.json') {
          return JSON.stringify({
            model: 'NVIDIA GeForce RTX 3080 Laptop GPU',
            vramMb: 8192,
            driverVersion: '595.71.05',
          });
        }
        return null;
      });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          throw new Error('nvidia-smi missing');
        }
        if (command.includes('/proc/driver/nvidia/gpus/*/information')) {
          return {
            stdout: 'Model:           NVIDIA GeForce RTX 3080 Laptop GPU\nGPU UUID:        GPU-test\nGPU Firmware:    595.71.05\n',
          };
        }
        if (command.includes('/proc/driver/nvidia/version')) {
          return {
            stdout: 'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.71.05  Release Build\n',
          };
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'Intel Core i7' });

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.model).toBe('NVIDIA GeForce RTX 3080 Laptop GPU');
      expect(profile.gpu.vramMb).toBe(8192);
      expect(profile.gpu.driverVersion).toBe('595.71.05');
    });

    it('SHALL augment detected NVIDIA GPUs with cached host VRAM when procfs lacks memory data', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Intel', model: 'Intel UHD Graphics', vram: 128, driverVersion: '1.0' }],
      });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/host/proc/meminfo') {
          return 'MemTotal: 67108864\nMemAvailable: 50331648';
        }
        if (filePath === '/data/state/hardware/nvidia.json') {
          return JSON.stringify({
            model: 'NVIDIA GeForce RTX 3090',
            vramMb: 24576,
            driverVersion: '580.65.06',
          });
        }
        return null;
      });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          throw new Error('nvidia-smi missing');
        }
        if (command.includes('/proc/driver/nvidia/gpus/*/information')) {
          return {
            stdout: 'Model:           NVIDIA GeForce RTX 3090\nGPU UUID:        GPU-test\n',
          };
        }
        if (command.includes('/proc/driver/nvidia/version')) {
          return {
            stdout: 'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.65.06  Release Build\n',
          };
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 24, brand: 'AMD Ryzen 9' });

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.model).toBe('NVIDIA GeForce RTX 3090');
      expect(profile.gpu.vramMb).toBe(24576);
      expect(profile.gpu.driverVersion).toBe('580.65.06');
    });

    it('SHALL fallback to cached host probe when nvidia-smi and procfs are unavailable', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/host/proc/meminfo') {
          return 'MemTotal: 67108864\nMemAvailable: 50331648';
        }
        if (filePath === '/data/state/hardware/nvidia.json') {
          return JSON.stringify({
            model: 'NVIDIA GeForce RTX 3080 Laptop GPU',
            vramMb: 8192,
            driverVersion: '595.71.05',
          });
        }
        return null;
      });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('--query-gpu=name,memory.total,driver_version')) {
          throw new Error('nvidia-smi missing');
        }
        if (command.includes('/proc/driver/nvidia/gpus/*/information')) {
          throw new Error('procfs missing');
        }
        if (command.includes('/proc/driver/nvidia/version')) {
          throw new Error('procfs missing');
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'Intel Core i7' });

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('nvidia');
      expect(profile.gpu.model).toBe('NVIDIA GeForce RTX 3080 Laptop GPU');
      expect(profile.gpu.vramMb).toBe(8192);
      expect(profile.gpu.driverVersion).toBe('595.71.05');
    });

    it('should detect AMD GPU vendor', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Advanced Micro Devices', model: 'Radeon RX 7900 XTX', vram: 24576, driverVersion: '6.2.0' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.available).toBe(true);
    });

    it('SHALL fallback to cached AMD host probe with full VRAM when the container cannot see the GPU', async () => {
      // Simulates Windows + Docker Desktop: the container's systeminformation
      // reports no GPU, but the desktop AMD host probe captured the real 24 GB
      // VRAM via the 64-bit qwMemorySize registry value (not the 4 GB-clamped
      // 32-bit AdapterRAM).
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/host/proc/meminfo') {
          return 'MemTotal: 67108864\nMemAvailable: 50331648';
        }
        if (filePath === '/data/state/hardware/amd.json') {
          return JSON.stringify({
            model: 'AMD Radeon RX 7900 XTX',
            vramMb: 24576,
            driverVersion: '31.0.24033.1003',
          });
        }
        return null;
      });
      execAsyncMock.mockImplementation(async () => {
        throw new Error('no GPU tooling in container');
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9 7950X' });

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.model).toBe('AMD Radeon RX 7900 XTX');
      expect(profile.gpu.vramMb).toBe(24576);
      expect(profile.gpu.driverVersion).toBe('31.0.24033.1003');
    });

    it('SHALL augment a detected AMD GPU with cached host VRAM when the container reports an implausibly low value', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Advanced Micro Devices', model: 'AMD Radeon RX 7900 XTX', vram: 256, driverVersion: '1.0' }],
      });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/host/proc/meminfo') {
          return 'MemTotal: 67108864\nMemAvailable: 50331648';
        }
        if (filePath === '/data/state/hardware/amd.json') {
          return JSON.stringify({
            model: 'AMD Radeon RX 7900 XTX',
            vramMb: 24576,
            driverVersion: '31.0.24033.1003',
          });
        }
        return null;
      });
      execAsyncMock.mockImplementation(async () => {
        throw new Error('no GPU tooling in container');
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9 7950X' });

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.vramMb).toBe(24576);
    });

    it('should set hostRocmAvailable from host ROCm probe cache', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Advanced Micro Devices', model: 'Radeon RX 7900 XTX', vram: 24576, driverVersion: '6.2.0' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/rocm.json') {
          return '{"available":true,"source":"host-dev-kfd"}';
        }
        return 'MemTotal: 67108864\nMemAvailable: 50331648';
      });
      filesystemService.pathExists.mockResolvedValue(false);

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.hostRocmAvailable).toBe(true);
      expect(profile.gpu.hostRocmKfdAvailable).toBe(true);
      expect(profile.gpu.runtimeAvailable).toBe(false);
    });

    it('SHALL tier a discrete AMD card by its VRAM when only the HOST has ROCm passthrough (container sees no /dev/kfd)', async () => {
      // systeminformation reports the lspci BAR (32 GB aperture) for a 24 GB RX 7900 XTX; sysfs has the truth.
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [
          { vendor: 'Advanced Micro Devices, Inc. [AMD/ATI]', model: 'Navi 31 [Radeon RX 7900 XTX]', vram: 32768, driverVersion: '' },
          { vendor: 'Advanced Micro Devices, Inc. [AMD/ATI]', model: 'Raphael', vram: 256, driverVersion: '' },
        ],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 24, brand: 'AMD Ryzen 9 7900X 12-Core Processor' });
      filesystemService.listFiles.mockImplementation(async (dirPath: string) =>
        dirPath === '/sys/class/drm' ? ['card0', 'card0-DP-4', 'card1', 'card1-DP-1', 'renderD128'] : [],
      );
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/rocm.json') return '{"available":true,"source":"host-dev-kfd"}';
        if (filePath === '/sys/class/drm/card0/device/mem_info_vram_total') return '536870912\n';
        if (filePath === '/sys/class/drm/card1/device/mem_info_vram_total') return '25753026560\n';
        return 'MemTotal: 64947200\nMemAvailable: 34543616';
      });
      // The Hub container itself has no /dev/kfd or /dev/dri.
      filesystemService.pathExists.mockResolvedValue(false);

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.vramMb).toBe(24560);
      expect(profile.gpu.runtimeAvailable).toBe(false);
      expect(profile.gpu.hostRocmKfdAvailable).toBe(true);
      expect(profile.tier).toBe('high');
    });

    it('SHALL keep an AMD box on cpu-only when neither the container nor the host has ROCm device nodes', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Advanced Micro Devices', model: 'Radeon RX 7900 XTX', vram: 24576, driverVersion: '6.2.0' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.listFiles.mockResolvedValue([]);
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/rocm.json') return '{"available":false,"source":"host-rocm-smi"}';
        return 'MemTotal: 67108864\nMemAvailable: 50331648';
      });
      filesystemService.pathExists.mockResolvedValue(false);

      const profile = await service.detect();

      expect(profile.gpu.hostRocmKfdAvailable).toBe(false);
      expect(profile.tier).toBe('cpu-only');
    });

    it('should set hostRocmAvailable when drivers are present but /dev/kfd is not ready', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Advanced Micro Devices', model: 'Radeon RX 7900 XTX', vram: 24576, driverVersion: '6.2.0' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/rocm.json') {
          return '{"available":false,"source":"host-rocm-smi"}';
        }
        return 'MemTotal: 67108864\nMemAvailable: 50331648';
      });
      filesystemService.pathExists.mockResolvedValue(false);

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.hostRocmAvailable).toBe(true);
      expect(profile.gpu.hostRocmKfdAvailable).toBe(false);
      expect(profile.gpu.runtimeAvailable).toBe(false);
    });

    it('SHALL parse rocm-smi VRAM total bytes instead of the card column', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'Advanced Micro Devices', model: 'Radeon RX 7900 XTX', vram: 0, driverVersion: '6.2.0' }],
      });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command === 'rocm-smi --showmeminfo vram --csv') {
          return {
            stdout: 'card,VRAM Total Memory (B),VRAM Total Used Memory (B)\ncard0,17179869184,1073741824\n',
          };
        }
        return { stdout: '{}' };
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('amd');
      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vramMb).toBe(16384);
    });

    it('should use host platform override for macOS GPU detection', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'darwin';
      // An Intel Mac with a discrete Radeon Pro — that is what this fixture describes, and the arch
      // now matters: a darwin host on arm64 is treated as Apple Silicon (see HW-mac-native below),
      // so leaving this to the developer's own machine would make the test pass or fail by laptop.
      archOverride.value = 'x64';
      const detectMacGpuSpy = vi.spyOn(service as any, 'detectMacGpu').mockResolvedValue({
        available: true,
        vendor: 'amd',
        model: 'Radeon Pro',
        vramMb: 8192,
        driverVersion: '',
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 8, brand: 'Intel Core i9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 33554432\nMemAvailable: 16777216');

      const profile = await service.detect();

      expect(detectMacGpuSpy).toHaveBeenCalledTimes(1);
      expect(profile.gpu.vendor).toBe('amd');
    });
  });

  // ─── S-HW-3: Hardware Tiers ────────────────────────────────────────

  describe('Hardware tier computation (HW-3)', () => {
    it('S-HW-3.1: high tier for ≥16 GB VRAM', () => {
      const tier = service.computeTier(
        { available: true, vendor: 'nvidia', model: 'RTX 4090', vramMb: 24576, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        { totalMb: 65536, availableMb: 32768 },
      );
      expect(tier).toBe('high');
    });

    it('S-HW-3.1: medium tier for 8-16 GB VRAM', () => {
      const tier = service.computeTier(
        { available: true, vendor: 'nvidia', model: 'RTX 3070', vramMb: 8192, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        { totalMb: 32768, availableMb: 16384 },
      );
      expect(tier).toBe('medium');
    });

    it('S-HW-3.1: low tier for 4-8 GB VRAM', () => {
      const tier = service.computeTier(
        { available: true, vendor: 'nvidia', model: 'GTX 1650', vramMb: 4096, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        { totalMb: 16384, availableMb: 8192 },
      );
      expect(tier).toBe('low');
    });

    it('S-HW-3.1: low tier when discrete GPU runtime is ready but VRAM is unknown (0)', () => {
      const tier = service.computeTier(
        { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        { totalMb: 32768, availableMb: 16384 },
      );
      expect(tier).toBe('low');
    });

    it('S-HW-3.1: low tier when SI reports PCIe framebuffer (32 MB) instead of real GDDR VRAM', () => {
      const tier = service.computeTier(
        { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 32, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        { totalMb: 32768, availableMb: 16384 },
      );
      expect(tier).toBe('low');
    });

    it('S-HW-3.1: cpu-only tier for no GPU but ≥16 GB RAM', () => {
      const tier = service.computeTier(
        { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
        { totalMb: 32768, availableMb: 16384 },
      );
      expect(tier).toBe('cpu-only');
    });

    it('S-HW-3.1: high tier for a discrete AMD card when only the host has ROCm passthrough', () => {
      const tier = service.computeTier(
        {
          available: true,
          vendor: 'amd',
          model: 'Radeon RX 7900 XTX',
          vramMb: 24560,
          unifiedMemory: false,
          driverVersion: '',
          runtimeAvailable: false,
          hostRocmKfdAvailable: true,
        },
        { totalMb: 63425, availableMb: 33734 },
      );
      expect(tier).toBe('high');
    });

    it('S-HW-3.1: cpu-only for a discrete AMD card with neither container nor host ROCm', () => {
      const tier = service.computeTier(
        {
          available: true,
          vendor: 'amd',
          model: 'Radeon RX 7900 XTX',
          vramMb: 24560,
          unifiedMemory: false,
          driverVersion: '',
          runtimeAvailable: false,
        },
        { totalMb: 63425, availableMb: 33734 },
      );
      expect(tier).toBe('cpu-only');
    });

    it('S-HW-3.1: the host ROCm shortcut is AMD-only — an NVIDIA card still needs the container runtime', () => {
      const tier = service.computeTier(
        {
          available: true,
          vendor: 'nvidia',
          model: 'RTX 4090',
          vramMb: 24576,
          unifiedMemory: false,
          driverVersion: '',
          runtimeAvailable: false,
          hostRocmKfdAvailable: true,
        },
        { totalMb: 63425, availableMb: 33734 },
      );
      expect(tier).toBe('cpu-only');
    });

    it('S-HW-3.1: insufficient tier for no GPU and <16 GB RAM', () => {
      const tier = service.computeTier(
        { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
        { totalMb: 8192, availableMb: 4096 },
      );
      expect(tier).toBe('insufficient');
    });

    it('S-HW-3.1: high tier for ≥32 GB unified memory (Apple Silicon)', () => {
      const tier = service.computeTier(
        { available: true, vendor: 'apple', model: 'M4 Max', vramMb: 65536, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
        { totalMb: 65536, availableMb: 32768 },
      );
      expect(tier).toBe('high');
    });

    it('S-HW-3.2: tier SHALL be recomputable on demand', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'RTX 4090', vram: 24576, driverVersion: '535' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile1 = await service.detect();
      const profile2 = await service.rescan();
      expect(profile1.tier).toBe(profile2.tier);
    });

    it('re-detects cached discrete GPU profiles when runtime is ready but VRAM was previously unknown', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
      vi.spyOn(service as any, 'detectDockerInfo').mockResolvedValue({ nvidiaRuntime: true, containerHostKind: 'native-linux' });
      (si.graphics as any)
        .mockResolvedValueOnce({
          controllers: [{ vendor: 'NVIDIA', model: 'RTX 3080', vram: 0, driverVersion: '535' }],
        })
        .mockResolvedValueOnce({
          controllers: [{ vendor: 'NVIDIA', model: 'RTX 3080', vram: 8192, driverVersion: '535' }],
        });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('docker info')) {
          return { stdout: '{"nvidia":{"path":"nvidia-container-runtime"}}' };
        }
        return { stdout: '{}' };
      });

      const initial = await service.detect();
      expect(initial.gpu.vramMb).toBe(0);
      expect(initial.tier).toBe('low');

      (service as any).cachedProfile = initial;
      const refreshed = await service.getProfile();

      expect(refreshed.gpu.vramMb).toBe(8192);
      expect(refreshed.tier).toBe('medium');
    });

    it('re-detects cached discrete GPU profiles when SI reports PCIe framebuffer (32 MB) instead of real GDDR VRAM', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
      vi.spyOn(service as any, 'detectDockerInfo').mockResolvedValue({ nvidiaRuntime: true, containerHostKind: 'native-linux' });
      (si.graphics as any)
        .mockResolvedValueOnce({
          controllers: [{ vendor: 'NVIDIA', model: 'RTX 3080', vram: 32, driverVersion: '535' }],
        })
        .mockResolvedValueOnce({
          controllers: [{ vendor: 'NVIDIA', model: 'RTX 3080', vram: 8192, driverVersion: '535' }],
        });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('docker info')) {
          return { stdout: '{"nvidia":{"path":"nvidia-container-runtime"}}' };
        }
        return { stdout: '{}' };
      });

      // SI returns 32 MB (PCIe BAR), the nvidia-smi cross-check fires but mock returns 0
      // → initial profile records 0 MB (unreliable reading discarded)
      const initial = await service.detect();
      expect(initial.gpu.vramMb).toBe(0);
      expect(initial.tier).toBe('low');

      (service as any).cachedProfile = initial;
      const refreshed = await service.getProfile();

      // Second detect(): SI now returns 8192 MB → correct tier
      expect(refreshed.gpu.vramMb).toBe(8192);
      expect(refreshed.tier).toBe('medium');
    });

    it('limits incomplete discrete GPU profile re-detection with cooldown', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const incompleteProfile = {
        gpu: { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        npu: { available: false, model: '' },
        ram: { totalMb: 32768, availableMb: 16384 },
        cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen' },
        effectiveInferenceMemoryMb: 0,
        tier: 'low',
      } as const;

      const detectSpy = vi.spyOn(service, 'detect').mockResolvedValue(incompleteProfile as any);
      (service as any).cachedProfile = incompleteProfile;

      await service.getProfile();
      await service.getProfile();
      expect(detectSpy).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'));
      await service.getProfile();
      expect(detectSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('applies cooldown after the initial detect() returns an incomplete profile', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const incompleteProfile = {
        gpu: { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        npu: { available: false, model: '' },
        ram: { totalMb: 32768, availableMb: 16384 },
        cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen' },
        effectiveInferenceMemoryMb: 0,
        tier: 'low',
      } as const;

      const detectSpy = vi.spyOn(service, 'detect').mockResolvedValue(incompleteProfile as any);

      // First call — no cachedProfile yet, runs detect() to populate cache
      await service.getProfile();
      expect(detectSpy).toHaveBeenCalledTimes(1);

      // Subsequent calls within the cooldown window must NOT re-detect
      await service.getProfile();
      await service.getProfile();
      expect(detectSpy).toHaveBeenCalledTimes(1);

      // After cooldown expires, should re-detect once
      vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'));
      await service.getProfile();
      expect(detectSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('applies cooldown when cache is populated via rescan()', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const incompleteProfile = {
        gpu: { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        npu: { available: false, model: '' },
        ram: { totalMb: 32768, availableMb: 16384 },
        cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen' },
        effectiveInferenceMemoryMb: 0,
        tier: 'low',
      } as const;

      const detectSpy = vi.spyOn(service, 'detect').mockResolvedValue(incompleteProfile as any);

      await service.rescan();
      expect(detectSpy).toHaveBeenCalledTimes(1);

      // rescan() now seeds cooldown for incomplete profiles, so no immediate re-detect
      await service.getProfile();
      expect(detectSpy).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'));
      await service.getProfile();
      expect(detectSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('does not advance cooldown when incomplete GPU profile refresh fails', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const incompleteProfile = {
        gpu: { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
        npu: { available: false, model: '' },
        ram: { totalMb: 32768, availableMb: 16384 },
        cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen' },
        effectiveInferenceMemoryMb: 0,
        tier: 'low',
      } as const;

      const detectSpy = vi
        .spyOn(service, 'detect')
        .mockRejectedValueOnce(new Error('transient probe failure'))
        .mockResolvedValue(incompleteProfile as any);

      (service as any).cachedProfile = incompleteProfile;

      await expect(service.getProfile()).rejects.toThrow(/transient probe failure/);
      await service.getProfile();

      expect(detectSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  // ─── RAM Detection ─────────────────────────────────────────────────

  describe('RAM detection', () => {
    it('should detect RAM from /host/proc/meminfo', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 4, brand: 'Intel' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 33554432\nMemAvailable: 16777216');

      const profile = await service.detect();

      expect(profile.ram.totalMb).toBe(32768); // 33554432 / 1024
      expect(profile.ram.availableMb).toBe(16384);
    });

    it('should fallback to os module if meminfo fails', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 4, brand: 'Intel' });
      filesystemService.readTextFile.mockRejectedValue(new Error('Not found'));

      const profile = await service.detect();

      expect(profile.ram.totalMb).toBeGreaterThan(0);
    });
  });

  // ─── macOS Host Probe (Docker-on-macOS) ────────────────────────────

  describe('macOS host probe (HW-mac)', () => {
    beforeEach(() => {
      // Default: no GPU detected inside Docker VM, no NVIDIA probe, VM RAM
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 12, brand: 'VirtualApple @ 2.50GHz' });
      execAsyncMock.mockResolvedValue({ stdout: '{}' });
    });

    it('should detect Apple Silicon and use host RAM from probe file', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin',
            cpuArch: 'arm64',
            source: 'desktop-host-macos',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 98304,
              availableRamMb: 83558,
              cpuCores: 24,
              cpuModel: 'Apple M2 Ultra',
              diskTotalGb: 494,
              diskUsedGb: 477,
              diskMount: '/',
            },
          });
        }
        if (filePath === '/host/proc/meminfo') return 'MemTotal: 7897344\nMemAvailable: 6815744';
        return null;
      });

      const profile = await service.detect();

      expect(profile.gpu.vendor).toBe('apple');
      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.unifiedMemory).toBe(true);
      expect(profile.gpu.model).toBe('Apple M2 Ultra (Apple Silicon)');
      expect(profile.gpu.vramMb).toBe(98304);
      expect(profile.ram.totalMb).toBe(98304);
      expect(profile.ram.availableMb).toBe(83558);
      expect(profile.cpu.arch).toBe('arm64');
      expect(profile.cpu.model).toBe('Apple M2 Ultra');
      expect(profile.tier).toBe('high');
    });

    it('should set gpu.available=true for Apple Silicon even when container GPU detection fails', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin',
            cpuArch: 'arm64',
            source: 'desktop-host-macos',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 98304,
              availableRamMb: 83558,
              cpuCores: 24,
              cpuModel: 'Apple M2 Ultra',
              diskTotalGb: 494,
              diskUsedGb: 477,
              diskMount: '/',
            },
          });
        }
        return null;
      });

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('apple');
    });

    it('should treat darwin arm64 probes as Apple Silicon even when cpuModel omits the Apple prefix', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin',
            cpuArch: 'arm64',
            source: 'desktop-host-macos',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 16384,
              availableRamMb: 12288,
              cpuCores: 10,
              cpuModel: 'M1 Pro',
              diskTotalGb: 494,
              diskUsedGb: 320,
              diskMount: '/',
            },
          });
        }
        return null;
      });

      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('apple');
      expect(profile.gpu.unifiedMemory).toBe(true);
      expect(profile.gpu.model).toBe('M1 Pro (Apple Silicon)');
      expect(profile.gpu.vramMb).toBe(16384);
      expect(profile.tier).toBe('high');
    });

    it('should use effective inference memory equal to available RAM for unified memory', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin',
            cpuArch: 'arm64',
            source: 'desktop-host-macos',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 98304,
              availableRamMb: 83558,
              cpuCores: 24,
              cpuModel: 'Apple M2 Ultra',
              diskTotalGb: 494,
              diskUsedGb: 477,
              diskMount: '/',
            },
          });
        }
        return null;
      });

      const profile = await service.detect();

      expect(profile.effectiveInferenceMemoryMb).toBe(83558);
    });

    it('should fallback to 85% of total RAM when availableRamMb is absent in probe', async () => {
      const probeWithoutAvailable = JSON.stringify({
        platform: 'darwin',
        cpuArch: 'arm64',
        cpuModel: 'Apple M2 Ultra',
        cpuCores: 24,
        totalRamMb: 98304,
        isAppleSilicon: true,
        source: 'desktop-host-macos-system-profiler',
      });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_system.json') return probeWithoutAvailable;
        return null;
      });

      const profile = await service.detect();

      expect(profile.ram.availableMb).toBe(Math.round(98304 * 0.85));
    });

    it('should correctly compute tier=high for Apple Silicon 96 GB', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin',
            cpuArch: 'arm64',
            source: 'desktop-host-macos',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 98304,
              availableRamMb: 83558,
              cpuCores: 24,
              cpuModel: 'Apple M2 Ultra',
              diskTotalGb: 494,
              diskUsedGb: 477,
              diskMount: '/',
            },
          });
        }
        return null;
      });

      const profile = await service.detect();

      expect(profile.tier).toBe('high');
    });

    it('should ignore the probe file when platform field is not darwin', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'linux',
            cpuArch: 'arm64',
            source: 'init-host-probe',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 98304,
              availableRamMb: 83558,
              cpuCores: 24,
              cpuModel: 'Apple M2 Ultra',
              diskTotalGb: 494,
              diskUsedGb: 477,
              diskMount: '/',
            },
          });
        }
        if (filePath === '/host/proc/meminfo') return 'MemTotal: 7897344\nMemAvailable: 6815744';
        return null;
      });

      const profile = await service.detect();

      expect(profile.ram.totalMb).toBe(98304);
      expect(profile.gpu.vendor).not.toBe('apple');
    });

    it('should handle Intel Mac (x86_64) from probe without unified memory', async () => {
      const intelMacProbe = JSON.stringify({
        platform: 'darwin',
        cpuArch: 'x86_64',
        cpuModel: 'Intel Core i9',
        cpuCores: 8,
        totalRamMb: 32768,
        availableRamMb: 24576,
        isAppleSilicon: false,
        source: 'desktop-host-macos-system-profiler',
      });
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('system_profiler')) {
          return {
            stdout: JSON.stringify({
              SPDisplaysDataType: [{ sppci_model: 'AMD Radeon Pro 5500M', sppci_vram: '8 GB' }],
            }),
          };
        }
        return { stdout: '{}' };
      });
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_system.json') return intelMacProbe;
        return null;
      });

      const profile = await service.detect();

      expect(profile.cpu.arch).toBe('x86_64');
      expect(profile.cpu.model).toBe('Intel Core i9');
      expect(profile.ram.totalMb).toBe(32768);
      expect(profile.gpu.unifiedMemory).toBe(false);
    });

    it('should fall back to container RAM when host metrics file is absent', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') return null;
        if (filePath === '/data/state/hardware/host_system.json') return null;
        if (filePath === '/host/proc/meminfo') return 'MemTotal: 7897344\nMemAvailable: 6815744';
        return null;
      });

      const profile = await service.detect();

      expect(profile.ram.totalMb).toBe(7712);
    });

    it('should fall back to container RAM when host metrics file is invalid', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({ schemaVersion: 1, platform: 'darwin', cpuArch: 'arm64' });
        }
        if (filePath === '/data/state/hardware/host_system.json') return null;
        if (filePath === '/host/proc/meminfo') return 'MemTotal: 7897344\nMemAvailable: 6815744';
        return null;
      });

      const profile = await service.detect();

      expect(profile.ram.totalMb).toBe(7712);
    });

    it('refreshes a stale cached container-only profile once the macOS host probe becomes available', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'darwin';
      (service as any).cachedProfile = {
        gpu: { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
        npu: { available: false, model: '' },
        ram: { totalMb: 7712, availableMb: 6656 },
        cpu: { arch: 'x86_64', cores: 12, model: 'VirtualApple @ 2.50GHz' },
        effectiveInferenceMemoryMb: 6656,
        tier: 'insufficient',
      };

      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin',
            cpuArch: 'arm64',
            source: 'desktop-host-macos',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 16384,
              availableRamMb: 12288,
              cpuCores: 10,
              cpuModel: 'Apple M1 Pro',
              diskTotalGb: 494,
              diskUsedGb: 320,
              diskMount: '/',
            },
          });
        }
        return null;
      });

      const profile = await service.getProfile();

      expect(profile.cpu.arch).toBe('arm64');
      expect(profile.cpu.model).toBe('Apple M1 Pro');
      expect(profile.gpu.vendor).toBe('apple');
      expect(profile.gpu.unifiedMemory).toBe(true);
      expect(profile.gpu.vramMb).toBe(16384);
      expect(profile.tier).toBe('high');
    });

    it('stops rereading the host probe once a host-probe-backed profile is cached', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'darwin';
      const hostProbeSpy = vi.spyOn(hostMetricsService, 'readHostProbe');

      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin',
            cpuArch: 'arm64',
            source: 'desktop-host-macos',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 16384,
              availableRamMb: 12288,
              cpuCores: 10,
              cpuModel: 'Apple M1 Pro',
              diskTotalGb: 494,
              diskUsedGb: 320,
              diskMount: '/',
            },
          });
        }
        return null;
      });

      await service.rescan();
      await service.getProfile();
      await service.getProfile();

      expect(hostProbeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Windows host probe (HW-win)', () => {
    beforeEach(() => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 8, brand: 'Virtual CPU' });
      (si.osInfo as any) = vi.fn().mockResolvedValue({
        platform: 'linux',
        distro: 'Alpine Linux',
        codename: 'Docker Desktop VM',
        release: '6.6.0',
      });
      execAsyncMock.mockResolvedValue({ stdout: '{}' });
    });

    it('should report Windows host OS and use probe RAM when win32 probe is present', async () => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') {
          return JSON.stringify({
            schemaVersion: 1,
            platform: 'win32',
            cpuArch: 'x86_64',
            source: 'init-host-probe',
            probedAt: '2026-01-01T00:00:00.000Z',
            host: {
              totalRamMb: 32768,
              availableRamMb: 16384,
              cpuCores: 16,
              cpuModel: 'Intel Core i7-12700K',
              diskTotalGb: 1024,
              diskUsedGb: 512,
              diskMount: 'C:',
            },
          });
        }
        if (filePath === '/host/proc/meminfo') return 'MemTotal: 8388608\nMemAvailable: 4194304';
        return null;
      });

      const profile = await service.detect();

      expect(profile.ram.totalMb).toBe(32768);
      expect(profile.ram.availableMb).toBe(16384);
      expect(profile.cpu.model).toBe('Intel Core i7-12700K');
      expect(profile.os).toEqual({ platform: 'win32', name: 'Windows', version: '' });
      expect(si.osInfo).not.toHaveBeenCalled();
    });
  });

  // ─── Container host kind (Docker Desktop vs native WSL2 engine vs Linux) ─────

  describe('container host kind detection', () => {
    beforeEach(() => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'RTX 4090', vram: 24576, driverVersion: '535' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');
    });

    // detectDockerInfo runs one call: `{{json .Runtimes}}\t{{.OperatingSystem}}\t{{.KernelVersion}}`
    function mockDockerInfo(runtimes: string, osName: string, kernel: string) {
      execAsyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes('.OperatingSystem')) return Promise.resolve({ stdout: `${runtimes}\t${osName}\t${kernel}` });
        return Promise.resolve({ stdout: '{}' });
      });
    }

    it('classifies Docker Desktop from OperatingSystem', async () => {
      mockDockerInfo('{"runc":{}}', 'Docker Desktop', '5.15.0-microsoft-standard-WSL2');
      const profile = await service.detect();
      expect(profile.gpu.containerHostKind).toBe('docker-desktop');
    });

    it('classifies a native WSL2 engine from a WSL kernel', async () => {
      mockDockerInfo('{"nvidia":{},"runc":{}}', 'Ubuntu 24.04.1 LTS', '5.15.167.4-microsoft-standard-WSL2');
      const profile = await service.detect();
      expect(profile.gpu.containerHostKind).toBe('wsl-engine');
    });

    it('classifies a native Linux engine', async () => {
      mockDockerInfo('{"runc":{}}', 'Ubuntu 22.04.3 LTS', '5.15.0-124-generic');
      const profile = await service.detect();
      expect(profile.gpu.containerHostKind).toBe('native-linux');
    });

    it('parses the nvidia runtime flag from the same call', async () => {
      mockDockerInfo('{"nvidia":{"path":"nvidia-container-runtime"},"runc":{}}', 'Ubuntu 24.04.1 LTS', '5.15.167.4-microsoft-standard-WSL2');
      const profile = await service.detect();
      expect(profile.gpu.runtimeAvailable).toBe(true);
    });

    it('is unknown when the daemon is unreachable', async () => {
      execAsyncMock.mockRejectedValue(new Error('docker daemon unreachable'));
      const profile = await service.detect();
      expect(profile.gpu.containerHostKind).toBe('unknown');
    });
  });
  // ─── Native macOS host (backend NOT in a container, so no host probe) ───────

  describe('native Apple Silicon host (HW-mac-native)', () => {
    /** What `system_profiler SPDisplaysDataType -json` really prints on an M2 Max: an Apple
     *  integrated GPU with a core count and NO VRAM field. Verified on the machine that took the
     *  committed `ai-hardware.png` store screenshot. */
    const APPLE_SILICON_SPDISPLAYS = JSON.stringify({
      SPDisplaysDataType: [
        {
          _name: 'Apple M2 Max',
          spdisplays_vendor: 'sppci_vendor_Apple',
          sppci_bus: 'spdisplays_builtin',
          sppci_cores: '38',
          sppci_device_type: 'spdisplays_gpu',
          sppci_model: 'Apple M2 Max',
        },
      ],
    });

    beforeEach(() => {
      process.env.CI_HUB_HOST_PLATFORM = 'darwin';
      archOverride.value = 'arm64';
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 12, brand: 'M2 Max' });
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.mem as any) = vi.fn().mockResolvedValue({ total: 103079215104, available: 10951401472 });
      execAsyncMock.mockResolvedValue({ stdout: APPLE_SILICON_SPDISPLAYS });
      // No probe file — nothing writes one when the backend runs directly on the Mac — but DO pin
      // the memory read. detectRam falls back to os.totalmem() when meminfo is absent, which would
      // make the tier assertion depend on how much RAM the machine running the test happens to have
      // (96 GB here, 16 GB on a GitHub runner: "high" vs "low").
      filesystemService.readTextFile.mockImplementation(async (filePath: string) =>
        filePath === '/host/proc/meminfo' ? 'MemTotal: 100663296\nMemAvailable: 10485760' : null,
      );
      filesystemService.pathExists.mockResolvedValue(false);
    });

    it('reports the integrated GPU instead of "No GPU detected"', async () => {
      const profile = await service.detect();

      expect(profile.gpu.available).toBe(true);
      expect(profile.gpu.vendor).toBe('apple');
      expect(profile.gpu.unifiedMemory).toBe(true);
      expect(profile.gpu.model).toBe('M2 Max (Apple Silicon)');
      expect(profile.gpu.runtimeAvailable).toBe(true);
    });

    it('sizes the GPU from unified memory and tiers on it', async () => {
      const profile = await service.detect();

      expect(profile.ram.totalMb).toBe(98304);
      expect(profile.gpu.vramMb).toBe(profile.ram.totalMb);
      expect(profile.tier).toBe('high');
    });

    it('leaves an Intel Mac alone', async () => {
      archOverride.value = 'x64';
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 8, brand: 'Intel Core i9' });
      execAsyncMock.mockResolvedValue({ stdout: JSON.stringify({ SPDisplaysDataType: [] }) });

      const profile = await service.detect();

      expect(profile.gpu.vendor).not.toBe('apple');
      expect(profile.gpu.available).toBe(false);
      expect(profile.gpu.unifiedMemory).toBe(false);
    });

    it('does not claim Apple Silicon for a non-darwin host', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'Ampere Altra' });
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 67108864\nMemAvailable: 50331648');

      const profile = await service.detect();

      expect(profile.gpu.vendor).not.toBe('apple');
    });
  });

  // ─── Live host RAM ─────────────────────────────────────────────────
  //
  // Measured on core-2 (Strix Halo, 128 GB unified) at :dev@61198ef62: GET /api/inference/hardware
  // served ram {totalMb:128085, availableMb:124547} — the boot-time figure from init-host-probe —
  // while `free -m` on the host said available 53052, with Ollama holding ~20 GB of qwen3.6:35b in
  // GTT. The KPI rail read "3% / 3G of 125G in use", and effectiveInferenceMemoryMb was the same
  // 124547, so the router budgeted model loads against RAM that was long gone.

  describe('live host RAM', () => {
    const KB = 1024;
    const STRIX_HALO_TOTAL_MB = 128085;
    const linuxProbe = (availableRamMb: number) =>
      JSON.stringify({
        schemaVersion: 1,
        platform: 'linux',
        cpuArch: 'x86_64',
        source: 'init-host-probe',
        probedAt: '2026-09-18T00:00:00.000Z',
        host: {
          totalRamMb: STRIX_HALO_TOTAL_MB,
          availableRamMb,
          cpuCores: 32,
          cpuModel: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S',
          diskTotalGb: 1863,
          diskUsedGb: 412,
          diskMount: '/',
        },
      });
    const meminfo = (availableMb: number, totalMb = STRIX_HALO_TOTAL_MB) => `MemTotal: ${totalMb * KB} kB\nMemAvailable: ${availableMb * KB} kB`;

    /** A meminfo the test can move between reads, beside a probe that never does. */
    const mountHost = (probe: string | null, meminfoRef: { current: string | null }) => {
      filesystemService.readTextFile.mockImplementation(async (filePath: string) => {
        if (filePath === '/data/state/hardware/host_metrics.json') return probe;
        if (filePath === '/host/proc/meminfo') return meminfoRef.current;
        return null;
      });
    };
    const meminfoReads = () => filesystemService.readTextFile.mock.calls.filter(([filePath]) => filePath === '/host/proc/meminfo').length;

    beforeEach(() => {
      process.env.CI_HUB_HOST_PLATFORM = 'linux';
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
      (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [] });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 32, brand: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S' });
      filesystemService.pathExists.mockResolvedValue(false);
      execAsyncMock.mockResolvedValue({ stdout: '{}' });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('unified node: a stale Linux probe loses to the meminfo bind mount, and the profile follows MemAvailable', async () => {
      const live = { current: meminfo(53052) };
      mountHost(linuxProbe(124547), live);

      const detected = await service.getProfile();

      expect(detected.gpu.unifiedMemory).toBe(true);
      expect(detected.ram.totalMb).toBe(STRIX_HALO_TOTAL_MB);
      // Not the probe's 124547: the host as it is now.
      expect(detected.ram.availableMb).toBe(53052);
      expect(detected.ram.usedMb).toBe(STRIX_HALO_TOTAL_MB - 53052);
      expect(detected.ram.sampledAt).toBe('2026-09-20T12:00:00.000Z');
      // The router's budget on a unified node IS the live figure.
      expect(detected.effectiveInferenceMemoryMb).toBe(53052);

      // Ollama unloads the 20 GB model; the cached profile must see it without a re-detect.
      const detectSpy = vi.spyOn(service, 'detect');
      live.current = meminfo(73500);
      vi.setSystemTime(new Date('2026-09-20T12:00:06.000Z'));

      const later = await service.getProfile();

      expect(detectSpy).not.toHaveBeenCalled();
      expect(later.ram.availableMb).toBe(73500);
      expect(later.ram.usedMb).toBe(STRIX_HALO_TOTAL_MB - 73500);
      expect(later.ram.sampledAt).toBe('2026-09-20T12:00:06.000Z');
      expect(later.effectiveInferenceMemoryMb).toBe(73500);
      // Everything that does not move between detections is served as cached.
      expect(later.gpu).toEqual(detected.gpu);
      expect(later.ram.totalMb).toBe(detected.ram.totalMb);
      expect(later.tier).toBe(detected.tier);
    });

    it('samples MemAvailable at most every few seconds, not per request', async () => {
      const live = { current: meminfo(53052) };
      mountHost(linuxProbe(124547), live);

      await service.getProfile();
      const readsAfterDetect = meminfoReads();

      // Twenty dashboard/route requests inside the sample window: no further reads.
      live.current = meminfo(40000);
      for (let i = 0; i < 20; i += 1) {
        vi.setSystemTime(new Date(`2026-09-20T12:00:0${Math.min(4, i % 5)}.000Z`));
        const profile = await service.getProfile();
        expect(profile.ram.availableMb).toBe(53052);
      }
      expect(meminfoReads()).toBe(readsAfterDetect);

      // Past the window: one read, and the figure moves.
      vi.setSystemTime(new Date('2026-09-20T12:00:05.500Z'));
      const profile = await service.getProfile();
      expect(profile.ram.availableMb).toBe(40000);
      expect(meminfoReads()).toBe(readsAfterDetect + 1);
    });

    it('discrete node: free RAM is live but the inference budget stays the card', async () => {
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'RTX 4090', vram: 24576, driverVersion: '535.129.03' }],
      });
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 16, brand: 'AMD Ryzen 9 7950X' });
      const live = { current: meminfo(49941, 65536) };
      mountHost(null, live);

      const detected = await service.getProfile();

      expect(detected.gpu.unifiedMemory).toBe(false);
      expect(detected.ram.availableMb).toBe(49941);
      expect(detected.ram.usedMb).toBe(65536 - 49941);
      expect(detected.effectiveInferenceMemoryMb).toBe(24576);

      live.current = meminfo(20000, 65536);
      vi.setSystemTime(new Date('2026-09-20T12:00:06.000Z'));

      const later = await service.getProfile();

      expect(later.ram.availableMb).toBe(20000);
      expect(later.ram.usedMb).toBe(65536 - 20000);
      // VRAM, as before: system RAM is not where a discrete card's models go.
      expect(later.effectiveInferenceMemoryMb).toBe(24576);
      expect(later.gpu.vramMb).toBe(24576);
    });

    it('macOS host probe: the Docker Desktop VM meminfo is not the host, so the probe snapshot stands', async () => {
      process.env.CI_HUB_HOST_PLATFORM = 'darwin';
      (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 12, brand: 'VirtualApple @ 2.50GHz' });
      const macProbe = JSON.stringify({
        schemaVersion: 1,
        platform: 'darwin',
        cpuArch: 'arm64',
        source: 'desktop-host-macos',
        probedAt: '2026-09-20T11:00:00.000Z',
        host: {
          totalRamMb: 98304,
          availableRamMb: 83558,
          cpuCores: 24,
          cpuModel: 'Apple M2 Ultra',
          diskTotalGb: 494,
          diskUsedGb: 477,
          diskMount: '/',
        },
      });
      // The VM: 7.5 GB, of which 6.5 GB free — nothing to do with the 96 GB Ollama runs in.
      const vm = { current: meminfo(6656, 7712) };
      mountHost(macProbe, vm);

      const detected = await service.getProfile();
      expect(detected.ram.totalMb).toBe(98304);
      expect(detected.ram.availableMb).toBe(83558);
      expect(detected.ram.sampledAt).toBeUndefined();
      expect(detected.effectiveInferenceMemoryMb).toBe(83558);

      vm.current = meminfo(1000, 7712);
      vi.setSystemTime(new Date('2026-09-20T12:00:06.000Z'));

      const later = await service.getProfile();
      expect(later.ram.availableMb).toBe(83558);
      expect(later.ram.sampledAt).toBeUndefined();
      expect(later.effectiveInferenceMemoryMb).toBe(83558);
    });

    it('keeps the last sample when a read yields no MemAvailable', async () => {
      const live = { current: meminfo(53052) };
      mountHost(linuxProbe(124547), live);
      const detected = await service.getProfile();
      expect(detected.ram.availableMb).toBe(53052);

      // A meminfo with no MemAvailable line parses to 0 — not a figure to serve or budget on.
      live.current = `MemTotal: ${STRIX_HALO_TOTAL_MB * KB} kB\nMemFree: 4096000 kB`;
      vi.setSystemTime(new Date('2026-09-20T12:00:06.000Z'));

      const later = await service.getProfile();
      expect(later.ram.availableMb).toBe(53052);
      expect(later.ram.sampledAt).toBe('2026-09-20T12:00:00.000Z');
    });

    it('rescan() serves the live figure too', async () => {
      const live = { current: meminfo(53052) };
      mountHost(linuxProbe(124547), live);

      const profile = await service.rescan();

      expect(profile.ram.availableMb).toBe(53052);
      expect(profile.ram.usedMb).toBe(STRIX_HALO_TOTAL_MB - 53052);
      expect(profile.effectiveInferenceMemoryMb).toBe(53052);
    });
  });
});
