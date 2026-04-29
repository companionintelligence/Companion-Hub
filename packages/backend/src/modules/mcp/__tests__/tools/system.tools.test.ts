import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { SystemTools } from '../../tools/system.tools';
import { SystemService } from '@/modules/system/system.service';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { DockerService } from '@/modules/docker/docker.service';

describe('SystemTools', () => {
  let tools: SystemTools;
  let systemService: MockProxy<SystemService>;
  let systemUpdateService: MockProxy<SystemUpdateService>;
  let _dockerService: MockProxy<DockerService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemTools,
        { provide: SystemService, useValue: mock<SystemService>() },
        { provide: SystemUpdateService, useValue: mock<SystemUpdateService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
      ],
    }).compile();
    tools = module.get<SystemTools>(SystemTools);
    systemService = module.get(SystemService);
    systemUpdateService = module.get(SystemUpdateService);
    _dockerService = module.get(DockerService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_system_load', () => {
    it('should return system metrics as numbers', async () => {
      systemService.getSystemLoad.mockResolvedValue({
        diskUsed: 50,
        diskSize: 100,
        percentUsed: 50,
        cpuLoad: 25,
        cpuCores: 4,
        memoryTotal: 8192,
        percentUsedMemory: 60,
      });
      const result = await tools.getSystemLoad();
      expect(result.diskUsed).toBe(50);
      expect(result.cpuCores).toBe(4);
      expect(result.percentUsedMemory).toBe(60);
    });
  });

  describe('hub_detect_services', () => {
    it('should return a list of detected Docker services', async () => {
      systemService.detectDockerServices.mockResolvedValue({ services: [{ name: 'nginx', image: 'nginx:latest', status: 'running' }] } as any);
      const result = await tools.detectServices();
      expect(result.services).toHaveLength(1);
    });
  });

  describe('hub_check_for_updates', () => {
    it('should return updateAvailable: false when up to date', async () => {
      systemUpdateService.checkForUpdates.mockResolvedValue({ current: '4.0.0', latest: '4.0.0', updateAvailable: false, releases: [] } as any);
      const result = await tools.checkForUpdates();
      expect(result.updateAvailable).toBe(false);
      expect(result.currentVersion).toBe('4.0.0');
    });
    it('should return updateAvailable: true with latestVersion when update available', async () => {
      systemUpdateService.checkForUpdates.mockResolvedValue({ current: '3.9.0', latest: '4.0.0', updateAvailable: true, releases: [] } as any);
      const result = await tools.checkForUpdates();
      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe('4.0.0');
    });
  });

  describe('hub_perform_update', () => {
    it('should update to latest when no targetVersion specified', async () => {
      systemUpdateService.performUpdate.mockResolvedValue({ success: true, message: 'Updated' } as any);
      await tools.performUpdate({});
      expect(systemUpdateService.performUpdate).toHaveBeenCalledWith(undefined);
    });
    it('should update to specific targetVersion when provided', async () => {
      systemUpdateService.performUpdate.mockResolvedValue({ success: true, message: 'Updated' } as any);
      await tools.performUpdate({ targetVersion: '4.1.0' });
      expect(systemUpdateService.performUpdate).toHaveBeenCalledWith('4.1.0');
    });
  });

  describe('hub_get_auto_updates', () => {
    it('should return current auto-update setting', async () => {
      systemUpdateService.getAutoUpdatesEnabled.mockReturnValue(true);
      const result = await tools.getAutoUpdates();
      expect(result).toEqual({ enabled: true });
    });
  });

  describe('hub_set_auto_updates', () => {
    it('should enable auto-updates', async () => {
      systemUpdateService.setAutoUpdatesEnabled.mockResolvedValue(undefined);
      const result = await tools.setAutoUpdates({ enabled: true });
      expect(systemUpdateService.setAutoUpdatesEnabled).toHaveBeenCalledWith(true);
      expect(result).toEqual({ enabled: true });
    });
    it('should disable auto-updates', async () => {
      systemUpdateService.setAutoUpdatesEnabled.mockResolvedValue(undefined);
      const result = await tools.setAutoUpdates({ enabled: false });
      expect(result).toEqual({ enabled: false });
    });
  });
});
