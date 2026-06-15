import { Test, type TestingModule } from '@nestjs/testing';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import si from 'systeminformation';

const { execAsyncMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
}));

vi.mock('systeminformation');
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
  });

  afterEach(() => {
    process.env.CI_HUB_HOST_PLATFORM = originalHostPlatform;
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
      vi.spyOn(service as any, 'detectNvidiaRuntime').mockResolvedValue(true);
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
      (si.graphics as any) = vi.fn().mockResolvedValue({
        controllers: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 3060', vram: 4095, driverVersion: '581.80' }],
      });
      vi.spyOn(service as any, 'detectNvidiaRuntime').mockResolvedValue(true);
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
      vi.spyOn(service as any, 'detectNvidiaRuntime').mockResolvedValue(true);
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
      vi.spyOn(service as any, 'detectNvidiaRuntime').mockResolvedValue(true);
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
});
