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
    (si.currentLoad as any) = vi.fn().mockResolvedValue({ currentLoad: 50, cpus: [{}, {}, {}, {}] });
    (si.fsSize as any) = vi.fn().mockResolvedValue([{ available: 50 * 1024 * 1024 * 1024, size: 100 * 1024 * 1024 * 1024 }]);
    // Fallback memory source used when /host/proc/meminfo is unavailable (host dev mode).
    (si.mem as any) = vi.fn().mockResolvedValue({ total: 16 * 1024 * 1024 * 1024, available: 8 * 1024 * 1024 * 1024, used: 8 * 1024 * 1024 * 1024 });

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
      expect(result.cpuCores).toBe(4);
      expect(result.diskSize).toBe(100);
      expect(result.diskUsed).toBe(50);
      expect(result.memoryTotal).toBe(8);
      expect(result.percentUsedMemory).toBe(50);
    });

    it('should handle meminfo read failure', async () => {
      filesystemService.readTextFile.mockRejectedValue(new Error('Fail'));

      const result = await service.getSystemLoad();

      // Falls back to si.mem() — no error logged at this level, just the graceful fallback.
      // si.mem mock returns 16 GB total, 8 GB available → 50% used.
      expect(si.mem).toHaveBeenCalled();
      expect(result.memoryTotal).toBe(16);
      expect(result.percentUsedMemory).toBe(50);
    });

    it('should handle missing disk info', async () => {
      (si.fsSize as any).mockResolvedValue([]);
      const result = await service.getSystemLoad();
      expect(result.diskSize).toBe(0);
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
