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
