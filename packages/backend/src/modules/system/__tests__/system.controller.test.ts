import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { pipeline } from 'node:stream/promises';
import { ResourceAllocatorService } from '../resource-allocator.service';
import { HostTelemetryService } from '../host-telemetry.service';
import { SystemController } from '../system.controller';
import { SystemService } from '../system.service';

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn(),
}));

describe('SystemController', () => {
  let controller: SystemController;
  let systemService: MockProxy<SystemService>;
  let dockerService: MockProxy<DockerService>;
  let hostTelemetry: MockProxy<HostTelemetryService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemController],
      providers: [
        { provide: SystemService, useValue: mock<SystemService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: ResourceAllocatorService, useValue: mock<ResourceAllocatorService>() },
        { provide: HostTelemetryService, useValue: mock<HostTelemetryService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(SystemController);
    systemService = moduleRef.get(SystemService);
    dockerService = moduleRef.get(DockerService);
    hostTelemetry = moduleRef.get(HostTelemetryService);
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
    const createResponse = (overrides: Partial<{ writableEnded: boolean; headersSent: boolean }> = {}) =>
      ({
        set: vi.fn(),
        on: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        writableEnded: true,
        headersSent: false,
        ...overrides,
      }) as any;

    it('should stream hub logs as a downloadable text file', async () => {
      const stdout = {} as any;
      const stderr = { on: vi.fn() } as any;
      const kill = vi.fn();
      dockerService.getLogsDownloadStream.mockResolvedValue({ stdout, stderr, kill } as any);
      vi.mocked(pipeline).mockResolvedValue(undefined);

      const res = createResponse();

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
      expect(kill).toHaveBeenCalledTimes(1);
    });

    it('cleans up through the response close handler on client aborts without double-killing', async () => {
      const stdout = {} as any;
      const stderr = { on: vi.fn() } as any;
      const kill = vi.fn();
      const clientAbortError = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
      dockerService.getLogsDownloadStream.mockResolvedValue({ stdout, stderr, kill } as any);
      vi.mocked(pipeline).mockImplementation(async (...args: unknown[]) => {
        const res = args[1] as ReturnType<typeof createResponse>;
        const closeHandler = res.on.mock.calls.find(([event]: [string, unknown]) => event === 'close')?.[1] as (() => void) | undefined;

        expect(closeHandler).toBeTypeOf('function');
        closeHandler?.();
        expect(kill).toHaveBeenCalledTimes(1);

        throw clientAbortError;
      });

      await expect(controller.downloadHubLogs(createResponse({ writableEnded: false }))).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledTimes(1);
    });

    it('sends 500 response for unexpected pipeline errors while still cleaning up', async () => {
      const stdout = {} as any;
      const stderr = { on: vi.fn() } as any;
      const kill = vi.fn();
      const error = new Error('unexpected pipeline failure');
      dockerService.getLogsDownloadStream.mockResolvedValue({ stdout, stderr, kill } as any);
      vi.mocked(pipeline).mockRejectedValue(error);

      const res = createResponse();
      await controller.downloadHubLogs(res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
      expect(kill).toHaveBeenCalledTimes(1);
    });

    it('sends 500 response when getLogsDownloadStream fails', async () => {
      dockerService.getLogsDownloadStream.mockRejectedValue(new Error('Docker socket not available'));

      const res = createResponse();
      await controller.downloadHubLogs(res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, message: 'Failed to start log download stream' }));
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

  describe('host telemetry', () => {
    it('returns persisted samples and events', async () => {
      hostTelemetry.getRecentSamples.mockResolvedValue([
        {
          sampledAt: '2026-08-18T12:00:00.000Z',
          cpuLoad: 41,
          cpuCores: 8,
          memoryUsed: 20,
          memoryTotal: 32,
          diskUsed: 100,
          diskTotal: 500,
          percentUsedMemory: 62,
          dockerAvailable: true,
          dockerInfo: { ncpu: 8, serverVersion: '27.0.0' },
          apps: null,
          source: 'collector',
        },
      ]);
      hostTelemetry.getRecentEvents.mockResolvedValue([
        {
          createdAt: '2026-08-18T12:00:01.000Z',
          level: 'info',
          source: 'hub.api',
          message: 'Hub API started',
          details: null,
        },
      ]);

      await expect(controller.hostTelemetryHistory()).resolves.toEqual({
        samples: [expect.objectContaining({ sampledAt: '2026-08-18T12:00:00.000Z', dockerAvailable: true, source: 'collector' })],
      });
      await expect(controller.hostEventLog()).resolves.toEqual({
        events: [expect.objectContaining({ source: 'hub.api', message: 'Hub API started' })],
      });
    });
  });
});
