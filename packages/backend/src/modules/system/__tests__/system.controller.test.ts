import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SystemController } from '../system.controller';
import { SystemService } from '../system.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('SystemController', () => {
  let controller: SystemController;
  let systemService: MockProxy<SystemService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemController],
      providers: [
        { provide: SystemService, useValue: mock<SystemService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(SystemController);
    systemService = moduleRef.get(SystemService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('systemLoad', () => {
    it('should return system load data', async () => {
      const mockLoad = {
        cpu: { load: 25 },
        memory: { total: 16000, used: 8000, available: 8000 },
        disk: { total: 500000, used: 250000, available: 250000 },
      };
      systemService.getSystemLoad.mockResolvedValue(mockLoad as any);

      const result = await controller.systemLoad();
      expect(result).toBeDefined();
      expect(systemService.getSystemLoad).toHaveBeenCalled();
    });
  });

  describe('downloadLocalCertificate', () => {
    it('should send certificate as PEM file', async () => {
      const certContent = '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----';
      systemService.getLocalCertificate.mockResolvedValue(certContent);

      const res = {
        set: vi.fn(),
        send: vi.fn().mockReturnThis(),
      } as any;

      await controller.downloadLocalCertificate(res);
      expect(res.set).toHaveBeenCalledWith({
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': 'attachment; filename=cert.pem',
      });
      expect(res.send).toHaveBeenCalledWith(certContent);
    });
  });

  describe('detectServices', () => {
    it('should return detected services', async () => {
      const services = [{ name: 'nginx', port: 80 }];
      systemService.detectDockerServices.mockResolvedValue(services as any);

      const result = await controller.detectServices();
      expect(result).toEqual(services);
    });
  });
});
