import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { pipeline } from 'node:stream/promises';
import { SystemController } from '../system.controller';
import { SystemService } from '../system.service';

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn(),
}));

describe('SystemController', () => {
  let controller: SystemController;
  let systemService: MockProxy<SystemService>;
  let dockerService: MockProxy<DockerService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemController],
      providers: [
        { provide: SystemService, useValue: mock<SystemService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(SystemController);
    systemService = moduleRef.get(SystemService);
    dockerService = moduleRef.get(DockerService);
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

  describe('downloadHubLogs', () => {
    it('should stream hub logs as a downloadable text file', async () => {
      const stdout = {} as any;
      const stderr = { on: vi.fn() } as any;
      const kill = vi.fn();
      dockerService.getLogsDownloadStream.mockResolvedValue({ stdout, stderr, kill } as any);
      vi.mocked(pipeline).mockResolvedValue(undefined);

      const res = {
        set: vi.fn(),
        on: vi.fn().mockReturnThis(),
        writableEnded: true,
      } as any;

      await controller.downloadHubLogs(res);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': expect.stringMatching(/^attachment; filename="ci-hub-logs-.+\.log"$/),
        }),
      );
      expect(stderr.on).toHaveBeenCalledWith('data', expect.any(Function));
      expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(pipeline).toHaveBeenCalledWith(stdout, res);

      const closeHandler = res.on.mock.calls.find(([event]: [string, unknown]) => event === 'close')?.[1] as (() => void) | undefined;
      expect(closeHandler).toBeTypeOf('function');
      closeHandler?.();
      expect(kill).toHaveBeenCalledTimes(1);
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
