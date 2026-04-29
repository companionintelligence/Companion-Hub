import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AgentHealthCheckService } from '../agent-health-check.service';
import { AgentNotifyService } from '../agent-notify.service';
import { SystemService } from '@/modules/system/system.service';

describe('AgentHealthCheckService', () => {
  let service: AgentHealthCheckService;
  let notifyService: MockProxy<AgentNotifyService>;
  let systemService: MockProxy<SystemService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentHealthCheckService,
        { provide: AgentNotifyService, useValue: mock<AgentNotifyService>() },
        { provide: SystemService, useValue: mock<SystemService>() },
      ],
    }).compile();

    service = module.get<AgentHealthCheckService>(AgentHealthCheckService);
    notifyService = module.get(AgentNotifyService);
    systemService = module.get(SystemService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('periodic health checks', () => {
    it('should emit system.high_disk when disk percentUsed > 90', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 95,
        diskSize: 100,
        percentUsed: 95,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 50,
      });
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledWith('system.high_disk', expect.any(Object), 'high');
    });

    it('should emit system.high_disk with urgency high', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 95,
        diskSize: 100,
        percentUsed: 95,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 50,
      });
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledWith('system.high_disk', expect.any(Object), 'high');
    });

    it('should not emit system.high_disk when disk percentUsed <= 90', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 50,
        diskSize: 100,
        percentUsed: 50,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 50,
      });
      await service.runHealthCheck();
      expect(notifyService.notify).not.toHaveBeenCalledWith('system.high_disk', expect.any(Object), expect.any(String));
    });

    it('should emit system.high_memory when percentUsedMemory > 90', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 50,
        diskSize: 100,
        percentUsed: 50,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 95,
      });
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledWith('system.high_memory', expect.any(Object), 'medium');
    });

    it('should emit system.high_memory with urgency medium', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 50,
        diskSize: 100,
        percentUsed: 50,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 95,
      });
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledWith('system.high_memory', expect.any(Object), 'medium');
    });

    it('should not emit system.high_memory when percentUsedMemory <= 90', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 50,
        diskSize: 100,
        percentUsed: 50,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 50,
      });
      await service.runHealthCheck();
      expect(notifyService.notify).not.toHaveBeenCalledWith('system.high_memory', expect.any(Object), expect.any(String));
    });

    it('should not re-emit same health event within 1 hour', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 95,
        diskSize: 100,
        percentUsed: 95,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 50,
      });
      await service.runHealthCheck();
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledTimes(1);
    });

    it('should re-emit health event after 1 hour has passed', async () => {
      service._setHealthDebounceMs(0);
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 95,
        diskSize: 100,
        percentUsed: 95,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 50,
      });
      await service.runHealthCheck();
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledTimes(2);
    });

    it('should debounce system.high_disk and system.high_memory independently', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 95,
        diskSize: 100,
        percentUsed: 95,
        cpuLoad: 10,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 95,
      });
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledTimes(2);
      await service.runHealthCheck();
      expect(notifyService.notify).toHaveBeenCalledTimes(2);
    });
  });
});
