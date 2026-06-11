import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Test, TestingModule } from '@nestjs/testing';
import type Dockerode from 'dockerode';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { describe, expect, it, vi } from 'vitest';
import { HostMetricsService } from '../host-metrics.service';
import { ResourceAllocatorService } from '../resource-allocator.service';

describe('ResourceAllocatorService', () => {
  let service: ResourceAllocatorService;
  let config: MockProxy<ConfigurationService>;
  let filesystem: MockProxy<FilesystemService>;
  let hostMetrics: MockProxy<HostMetricsService>;
  let docker: { info: ReturnType<typeof vi.fn> };

  const gb = (n: number) => n * 1024 * 1024 * 1024;

  const setup = async (userSettings: Record<string, unknown> = {}) => {
    config = mock<ConfigurationService>();
    filesystem = mock<FilesystemService>();
    hostMetrics = mock<HostMetricsService>();
    docker = { info: vi.fn().mockResolvedValue({ NCPU: 8, MemTotal: gb(16), ServerVersion: '27.0.0' }) };

    config.get.mockImplementation((key: string) => {
      if (key === 'userSettings') return userSettings;
      return undefined;
    });
    hostMetrics.readHostProbe.mockResolvedValue(null);
    hostMetrics.detectRuntimeKind.mockReturnValue('container-only');
    hostMetrics.detectVmWedge.mockReturnValue(false);
    filesystem.readTextFile.mockResolvedValue(null as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourceAllocatorService,
        { provide: ConfigurationService, useValue: config },
        { provide: FilesystemService, useValue: filesystem },
        { provide: HostMetricsService, useValue: hostMetrics },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: DOCKERODE, useValue: docker as unknown as Dockerode },
      ],
    }).compile();

    service = module.get(ResourceAllocatorService);
  };

  it('computes per-app caps from the Docker daemon capacity', async () => {
    await setup();

    const limits = await service.getAutoAppLimits();

    // 75% of 8 cores, 50% of 16384 MB
    expect(limits).toEqual({ cpuLimit: '6', memoryLimit: '8192M' });
  });

  it('returns no limits when the Docker daemon is unreachable', async () => {
    await setup();
    docker.info.mockRejectedValue(new Error('socket not found'));

    const limits = await service.getAutoAppLimits();

    expect(limits).toEqual({});
  });

  it('caches docker info between calls', async () => {
    await setup();

    await service.getAutoAppLimits();
    await service.getAutoAppLimits();

    expect(docker.info).toHaveBeenCalledTimes(1);
  });

  it('never allocates below the per-app memory floor on small machines', async () => {
    await setup();
    docker.info.mockResolvedValue({ NCPU: 2, MemTotal: gb(2) });

    const limits = await service.getAutoAppLimits();

    expect(limits.memoryLimit).toBe('1024M');
    expect(limits.cpuLimit).toBe('1.5');
  });

  it('lets user settings override auto allocation per field', async () => {
    await setup({ defaultAppCpuLimit: '2', autoAllocateAppResources: true });

    const defaults = await service.getEffectiveAppDefaults();

    expect(defaults.cpuLimit).toBe('2');
    expect(defaults.memoryLimit).toBe('8192M');
    expect(defaults.autoAllocated).toBe(true);
  });

  it('respects the auto allocation opt-out', async () => {
    await setup({ autoAllocateAppResources: false });

    const defaults = await service.getEffectiveAppDefaults();

    expect(defaults).toEqual({ cpuLimit: undefined, memoryLimit: undefined, autoAllocated: false });
    expect(docker.info).not.toHaveBeenCalled();
  });

  it('builds a resource overview with VM sizing recommendations', async () => {
    await setup();
    hostMetrics.readHostProbe.mockResolvedValue({
      schemaVersion: 1,
      platform: 'darwin',
      cpuArch: 'arm64',
      source: 'desktop-host-macos',
      probedAt: '2026-01-01T00:00:00.000Z',
      host: { totalRamMb: 65536, availableRamMb: 32768, cpuCores: 12, diskTotalGb: 1000, diskUsedGb: 400, diskMount: '/' },
    } as never);
    hostMetrics.detectRuntimeKind.mockReturnValue('docker-desktop-vm');
    hostMetrics.detectVmWedge.mockReturnValue(true);
    hostMetrics.recommendedDockerRamMb.mockReturnValue(49152);

    const overview = await service.getResourceOverview();

    expect(overview.docker).toEqual({ cpuCores: 8, memTotalMb: 16384, serverVersion: '27.0.0' });
    expect(overview.hasVmWedge).toBe(true);
    expect(overview.recommended).toEqual({ dockerRamMb: 49152, dockerCpus: 12, dockerDiskGb: 500 });
    expect(overview.appDefaults).toEqual({ cpuLimit: '6', memoryLimit: '8192M', autoAllocated: true });
  });
});
