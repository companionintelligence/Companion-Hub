import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { Get } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { pipeline } from 'node:stream/promises';
import { AuthGuard } from '../../auth/auth.guard';
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

  describe('route guards', () => {
    // There is no global APP_GUARD in this app: AuthGuard is applied per-method,
    // so a route declared between two guarded ones inherits nothing. That is how
    // GET /api/system/certificate — which serves the appliance's root CA trust
    // anchor — ended up reachable without a session. Enumerating the prototype
    // rather than a hand-written list means a newly added route fails here too.
    //
    // Enumerating it *unfiltered* would over-reach the other way: a private helper
    // on the controller is not reachable over HTTP and has nothing to guard, so
    // demanding AuthGuard on it would fail this suite for a change that is safe.
    // Nest stamps PATH_METADATA and METHOD_METADATA onto exactly the methods its
    // router will expose, which is the set this test means.
    const isRouteHandler = (prototype: object, name: string): boolean => {
      if (name === 'constructor') {
        return false;
      }

      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') {
        return false;
      }

      return Reflect.hasMetadata(PATH_METADATA, handler) && Reflect.hasMetadata(METHOD_METADATA, handler);
    };

    const routeHandlers = Object.getOwnPropertyNames(SystemController.prototype).filter((name) => isRouteHandler(SystemController.prototype, name));

    it('covers every route on the controller', () => {
      expect(routeHandlers.length).toBeGreaterThan(0);
    });

    it('counts routes only, so a future helper method cannot fail this suite', () => {
      class Fixture {
        @Get('/thing')
        thing() {
          return null;
        }

        // Not reachable over HTTP, so there is nothing here for AuthGuard to protect.
        helper() {
          return null;
        }
      }

      expect(Object.getOwnPropertyNames(Fixture.prototype).filter((name) => isRouteHandler(Fixture.prototype, name))).toEqual(['thing']);
    });

    it.each(routeHandlers)('guards %s with AuthGuard', (name) => {
      const handler = (SystemController.prototype as Record<string, unknown>)[name];
      // Default to `[]` rather than asserting on the raw lookup: an unguarded route
      // reads back as `undefined`, and `expect(undefined).toContain(...)` passes.
      const guards = (Reflect.getMetadata('__guards__', handler as object) ?? []) as unknown[];

      expect(guards).toContain(AuthGuard);
    });
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
