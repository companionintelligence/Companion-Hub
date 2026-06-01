import { Test, TestingModule } from '@nestjs/testing';
import { SystemService } from '../system.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '../host-metrics.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import si from 'systeminformation';

vi.mock('systeminformation');

describe('SystemService', () => {
  let service: SystemService;
  let configService: MockProxy<ConfigurationService>;
  let filesystemService: MockProxy<FilesystemService>;
  let loggerService: MockProxy<LoggerService>;
  let hostMetricsService: MockProxy<HostMetricsService>;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    filesystemService = mock<FilesystemService>();
    loggerService = mock<LoggerService>();
    hostMetricsService = mock<HostMetricsService>();

    configService.get.mockReturnValue({ dataDir: '/data' } as any);

    (si.currentLoad as any) = vi.fn().mockResolvedValue({ currentLoad: 50, cpus: [{}, {}, {}, {}] });

    hostMetricsService.getDisplayLoad.mockResolvedValue({
      diskUsed: 50,
      diskSize: 100,
      percentUsed: 50,
      cpuLoad: 50,
      cpuCores: 4,
      memoryTotal: 32,
      memoryUsed: 16,
      percentUsedMemory: 50,
      hasVmWedge: true,
      runtimeKind: 'docker-desktop-vm',
      containerMemoryTotal: 8,
      containerMemoryUsed: 3,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemService,
        { provide: ConfigurationService, useValue: configService },
        { provide: FilesystemService, useValue: filesystemService },
        { provide: LoggerService, useValue: loggerService },
        { provide: HostMetricsService, useValue: hostMetricsService },
      ],
    }).compile();

    service = module.get<SystemService>(SystemService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getSystemLoad', () => {
    it('should return host-primary load stats from HostMetricsService', async () => {
      const result = await service.getSystemLoad();

      expect(si.currentLoad).toHaveBeenCalled();
      expect(hostMetricsService.getDisplayLoad).toHaveBeenCalledWith(50, 4);
      expect(result.cpuLoad).toBe(50);
      expect(result.cpuCores).toBe(4);
      expect(result.diskSize).toBe(100);
      expect(result.memoryTotal).toBe(32);
      expect(result.hasVmWedge).toBe(true);
      expect(result.containerMemoryTotal).toBe(8);
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
