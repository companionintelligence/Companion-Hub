import { Test, TestingModule } from '@nestjs/testing';
import { SystemService } from '../system.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import si from 'systeminformation';

vi.mock('systeminformation');

describe('SystemService', () => {
  let service: SystemService;
  let configService: MockProxy<ConfigurationService>;
  let filesystemService: MockProxy<FilesystemService>;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    filesystemService = mock<FilesystemService>();
    loggerService = mock<LoggerService>();

    configService.get.mockReturnValue({ dataDir: '/data' } as any);

    // Mock systeminformation
    (si.currentLoad as any) = vi.fn().mockResolvedValue({ currentLoad: 50 });
    (si.fsSize as any) = vi.fn().mockResolvedValue([{ available: 50 * 1024 * 1024 * 1024, size: 100 * 1024 * 1024 * 1024 }]);
    (si.graphics as any) = vi.fn().mockResolvedValue({ controllers: [{ utilizationGpu: 30, memoryTotal: 8192, memoryUsed: 4096 }] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemService,
        { provide: ConfigurationService, useValue: configService },
        { provide: FilesystemService, useValue: filesystemService },
        { provide: LoggerService, useValue: loggerService },
      ],
    }).compile();

    service = module.get<SystemService>(SystemService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getSystemLoad', () => {
    it('should return system load stats', async () => {
      // Mock meminfo
      const keyMemTotal = 'MemTotal:';
      const keyMemAvail = 'MemAvailable:';
      const memTotal = 8 * 1024 * 1024; // 8GB in KB
      const memAvail = 4 * 1024 * 1024; // 4GB in KB
      const memInfo = `${keyMemTotal} ${memTotal}\n${keyMemAvail} ${memAvail}`;

      filesystemService.readTextFile.mockResolvedValue(memInfo);

      const result = await service.getSystemLoad();

      expect(si.currentLoad).toHaveBeenCalled();
      expect(si.fsSize).toHaveBeenCalled();
      expect(filesystemService.readTextFile).toHaveBeenCalledWith('/host/proc/meminfo');

      expect(result.cpuLoad).toBe(50);
      expect(result.diskSize).toBe(100);
      expect(result.diskUsed).toBe(50);
      expect(result.memoryTotal).toBe(8);
      expect(result.percentUsedMemory).toBe(50);
      expect(result.gpuLoad).toBe(30);
      expect(result.vramUsedPercent).toBe(50);
    });

    it('should handle meminfo read failure', async () => {
      filesystemService.readTextFile.mockRejectedValue(new Error('Fail'));

      const result = await service.getSystemLoad();

      expect(loggerService.error).toHaveBeenCalled();
      // Should default to 0
      expect(result.memoryTotal).toBe(0);
    });

    it('should handle missing disk info', async () => {
      (si.fsSize as any).mockResolvedValue([]);
      const result = await service.getSystemLoad();
      expect(result.diskSize).toBe(0);
    });

    it('should handle GPU info failure gracefully', async () => {
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 8388608\nMemAvailable: 4194304');
      (si.graphics as any).mockRejectedValue(new Error('No GPU'));

      const result = await service.getSystemLoad();

      expect(loggerService.error).toHaveBeenCalled();
      expect(result.gpuLoad).toBe(0);
      expect(result.vramUsedPercent).toBe(0);
    });

    it('should handle missing GPU controller gracefully', async () => {
      filesystemService.readTextFile.mockResolvedValue('MemTotal: 8388608\nMemAvailable: 4194304');
      (si.graphics as any).mockResolvedValue({ controllers: [] });

      const result = await service.getSystemLoad();

      expect(result.gpuLoad).toBe(0);
      expect(result.vramUsedPercent).toBe(0);
    });
  });

  describe('getLocalCertificate', () => {
    it('should return certificate content if exists', async () => {
      filesystemService.pathExists.mockResolvedValue(true);
      filesystemService.readTextFile.mockResolvedValue('CERT_CONTENT');

      const result = await service.getLocalCertificate();

      expect(filesystemService.pathExists).toHaveBeenCalledWith('/data/traefik/tls/cert.pem');
      expect(result).toBe('CERT_CONTENT');
    });

    it('should return undefined if not exists', async () => {
      filesystemService.pathExists.mockResolvedValue(false);
      const result = await service.getLocalCertificate();
      expect(result).toBeUndefined();
    });
  });
});
