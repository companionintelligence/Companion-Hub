import { DATABASE } from '@/core/database/database.module';
import { LoggerService } from '@/core/logger/logger.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { HostTelemetryService } from '../host-telemetry.service';
import { SystemService } from '../system.service';

describe('HostTelemetryService', () => {
  let service: HostTelemetryService;
  let inserted: unknown[];
  let events: unknown[];
  let docker: { info: ReturnType<typeof vi.fn> };
  let systemService: MockProxy<SystemService>;
  let db: {
    insert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    query: {
      hostTelemetrySample: { findMany: ReturnType<typeof vi.fn> };
      hostEventLog: { findMany: ReturnType<typeof vi.fn> };
    };
  };

  beforeEach(async () => {
    inserted = [];
    events = [];
    docker = {
      info: vi.fn().mockResolvedValue({
        NCPU: 8,
        MemTotal: 16 * 1024 * 1024 * 1024,
        Containers: 12,
        ContainersRunning: 9,
        Images: 20,
        ServerVersion: '27.0.0',
        Driver: 'overlay2',
        OperatingSystem: 'Ubuntu',
        Name: 'host',
      }),
    };
    systemService = mock<SystemService>();
    systemService.getSystemLoad.mockResolvedValue({
      cpuLoad: 41.2,
      cpuCores: 8,
      memoryUsed: 20,
      memoryTotal: 32,
      diskUsed: 100,
      diskSize: 500,
      percentUsedMemory: 62,
    } as never);

    db = {
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          if (row && typeof row === 'object' && 'level' in row) {
            events.push(row);
          } else {
            inserted.push(row);
          }
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      query: {
        hostTelemetrySample: { findMany: vi.fn().mockResolvedValue([]) },
        hostEventLog: { findMany: vi.fn().mockResolvedValue([]) },
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        HostTelemetryService,
        { provide: DATABASE, useValue: db },
        { provide: DOCKERODE, useValue: docker },
        { provide: SystemService, useValue: systemService },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    service = module.get(HostTelemetryService);
  });

  it('persists a slim docker + host snapshot', async () => {
    await service.collect('collector');

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      source: 'collector',
      cpuLoad: 41,
      cpuCores: 8,
      dockerAvailable: true,
      dockerInfo: expect.objectContaining({ ncpu: 8, containersRunning: 9, serverVersion: '27.0.0' }),
    });
  });

  it('reuses docker.info within the 5s cache window', async () => {
    await service.collect('collector');
    await service.collect('collector');

    expect(docker.info).toHaveBeenCalledTimes(1);
  });

  it('records a docker availability flip as an event', async () => {
    await service.collect('collector');
    vi.spyOn(service, 'readDockerInfo').mockResolvedValue({ available: false, info: null });

    await service.collect('collector');

    expect(events.some((event) => event && typeof event === 'object' && (event as { message?: string }).message?.includes('unavailable'))).toBe(true);
  });

  it('maps stored rows into history samples', async () => {
    db.query.hostTelemetrySample.findMany.mockResolvedValue([
      {
        sampledAt: '2026-08-18T12:00:00.000Z',
        cpuLoad: 10,
        cpuCores: 8,
        memoryUsed: 4,
        memoryTotal: 16,
        diskUsed: 20,
        diskTotal: 100,
        percentUsedMemory: 25,
        dockerAvailable: true,
        dockerInfo: { ncpu: 8 },
        apps: [
          { appUrn: 'ci-memory:ci-marketplace', appName: 'ci-memory', status: 'running', cpuPercent: 12, memoryUsageBytes: 1, containerCount: 1 },
        ],
        source: 'runtime-monitor',
      },
    ]);

    await expect(service.getRuntimeHistory(24)).resolves.toEqual([
      {
        sampledAt: '2026-08-18T12:00:00.000Z',
        apps: [expect.objectContaining({ appUrn: 'ci-memory:ci-marketplace' })],
      },
    ]);
  });
});
