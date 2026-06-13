import { describe, expect, it, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '../apps.repository';
import { AppsService } from '../apps.service';
import { DockerService } from '@/modules/docker/docker.service';

describe('AppRuntimeMonitorService', () => {
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;
  let appsRepository: MockProxy<AppsRepository>;
  let appsService: MockProxy<AppsService>;
  let dockerService: MockProxy<DockerService>;
  let service: AppRuntimeMonitorService;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = mock<LoggerService>();
    config = mock<ConfigurationService>();
    appsRepository = mock<AppsRepository>();
    appsService = mock<AppsService>();
    dockerService = mock<DockerService>();

    config.get.mockImplementation((key: string) => {
      if (key === 'userSettings') {
        return {} as any;
      }
      return undefined as any;
    });

    service = new AppRuntimeMonitorService(logger, config, appsRepository, appsService, dockerService);
  });

  it('does not probe healthy running apps in the hot path', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      appName: 'test-app',
      appStoreSlug: 'store',
      status: 'running',
      config: {},
      updatedAt: new Date().toISOString(),
    } as any);
    dockerService.getAppRuntimeStats.mockResolvedValue([
      {
        containerId: 'abc',
        name: 'svc',
        state: 'running',
        status: 'Up',
        health: 'healthy',
        cpuPercent: 12,
        memoryUsageBytes: 100,
        memoryLimitBytes: 1000,
      },
    ]);

    const result = await service.getAppRuntimeHealth('test-app:store' as any);

    expect(result.responsive).toBe(true);
    expect(appsService.checkAppAvailability).not.toHaveBeenCalled();
  });

  it('caches availability probes for suspicious apps', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      appName: 'test-app',
      appStoreSlug: 'store',
      status: 'running',
      config: {},
      updatedAt: new Date().toISOString(),
    } as any);
    dockerService.getAppRuntimeStats.mockResolvedValue([
      {
        containerId: 'abc',
        name: 'svc',
        state: 'running',
        status: 'Up',
        health: 'healthy',
        cpuPercent: 95,
        memoryUsageBytes: 100,
        memoryLimitBytes: 1000,
      },
    ]);
    appsService.checkAppAvailability.mockResolvedValue({
      available: false,
      detail: 'Connection refused',
    } as any);

    const first = await service.getAppRuntimeHealth('test-app:store' as any);
    const second = await service.getAppRuntimeHealth('test-app:store' as any);

    expect(first.responsive).toBe(false);
    expect(second.responsive).toBe(false);
    expect(appsService.checkAppAvailability).toHaveBeenCalledTimes(1);
  });

  it('returns not found when the app record is gone', async () => {
    appsRepository.getAppByUrn.mockResolvedValue(null);

    await expect(service.getAppRuntimeHealth('missing:store' as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});
