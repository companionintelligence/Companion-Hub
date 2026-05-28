import { Test, type TestingModule } from '@nestjs/testing';
import { HardwareInspectorService } from '../hardware-inspector.service';
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

    it('S-HW-3.1: low tier when discrete GPU runtime is ready but VRAM is unknown', () => {
      const tier = service.computeTier(
        { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
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
});
