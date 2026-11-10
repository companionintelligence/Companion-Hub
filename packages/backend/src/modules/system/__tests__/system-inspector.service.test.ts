import { Test, type TestingModule } from '@nestjs/testing';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { PortManagerService } from '@/modules/network/port-manager.service';
import si from 'systeminformation';
import os from 'node:os';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostMetricsService } from '../host-metrics.service';
import { SystemInspectorService } from '../system-inspector.service';

vi.mock('systeminformation');

const { detectHubContainer } = vi.hoisted(() => ({ detectHubContainer: vi.fn(() => true) }));
vi.mock('@/modules/inference/backends/host-url.util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/inference/backends/host-url.util')>()),
  detectHubContainer,
}));

describe('SystemInspectorService', () => {
  let service: SystemInspectorService;
  let hostMetrics: MockProxy<HostMetricsService>;
  const docker = { info: vi.fn() };

  beforeEach(async () => {
    docker.info.mockReset();
    detectHubContainer.mockReturnValue(true);
    hostMetrics = mock<HostMetricsService>();
    hostMetrics.getDisplayLoad.mockResolvedValue({
      diskUsed: 10,
      diskSize: 100,
      percentUsed: 10,
      cpuLoad: 0,
      cpuCores: 4,
      memoryTotal: 8,
      memoryUsed: 4,
      percentUsedMemory: 50,
      hasVmWedge: false,
      runtimeKind: 'linux-native',
    });
    hostMetrics.readHostProbe.mockResolvedValue(null);
    (si.currentLoad as any) = vi.fn().mockResolvedValue({ currentLoad: 1 });
    (si.cpu as any) = vi.fn().mockResolvedValue({ cores: 4, manufacturer: 'Test', brand: 'CPU' });
    vi.spyOn(os, 'hostname').mockReturnValue('db594972ed61');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemInspectorService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: PortManagerService, useValue: mock<PortManagerService>() },
        { provide: HostMetricsService, useValue: hostMetrics },
        { provide: FilesystemService, useValue: mock<FilesystemService>() },
        { provide: DOCKERODE, useValue: docker },
      ],
    }).compile();

    service = module.get(SystemInspectorService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSystemHealth hostname', () => {
    it("names the machine Docker runs on, not the Hub's own container", async () => {
      docker.info.mockResolvedValue({ Name: 'my-server', ServerVersion: '29.0.0' });

      expect((await service.getSystemHealth()).hostname).toBe('my-server');
    });

    it("falls back to the process's hostname when Docker can't be asked", async () => {
      docker.info.mockRejectedValue(new Error('connect ENOENT'));

      expect((await service.getSystemHealth()).hostname).toBe('db594972ed61');
    });

    it("falls back to the process's hostname when Docker reports an empty name", async () => {
      docker.info.mockResolvedValue({ Name: '', ServerVersion: '29.0.0' });

      expect((await service.getSystemHealth()).hostname).toBe('db594972ed61');
    });

    it("keeps the process's hostname when the Hub runs outside a container", async () => {
      detectHubContainer.mockReturnValue(false);
      vi.mocked(os.hostname).mockReturnValue('my-laptop');
      docker.info.mockResolvedValue({ Name: 'docker-desktop', ServerVersion: '29.0.0' });

      expect((await service.getSystemHealth()).hostname).toBe('my-laptop');
    });
  });
});
