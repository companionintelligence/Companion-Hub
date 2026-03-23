import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemUpdateService } from '../system-update.service';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    promises: { writeFile: vi.fn() },
  },
}));

describe('SystemUpdateService', () => {
  let service: SystemUpdateService;
  let mockRegistryService: any;
  let mockConfig: any;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    mockConfig = {
      getConfig: vi.fn(() => ({ __prod__: false, version: '1.0.0' })),
      get: vi.fn(() => ({ dataDir: '/data' })),
    };
    mockRegistryService = {
      getTagsSince: vi.fn(),
    };
    service = new SystemUpdateService(mockLogger as any, mockConfig as any, mockRegistryService as any);
  });

  describe('checkForUpdates', () => {
    it('should return update available when newer versions exist', async () => {
      mockRegistryService.getTagsSince.mockResolvedValue(['1.1.0']);

      const result = await service.checkForUpdates();
      expect(result.updateAvailable).toBe(true);
      expect(result.current).toBe('1.0.0');
      expect(result.latest).toBe('1.1.0');
    });

    it('should return no update when no newer versions', async () => {
      mockRegistryService.getTagsSince.mockResolvedValue([]);

      const result = await service.checkForUpdates();
      expect(result.updateAvailable).toBe(false);
      expect(result.current).toBe('1.0.0');
      expect(result.latest).toBe('1.0.0');
    });
  });

  describe('performUpdate', () => {
    it('should pull the new image and schedule restart', async () => {
      const { spawn } = await import('node:child_process');
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'close') cb(0);
        }),
        unref: vi.fn(),
      };
      (spawn as any).mockReturnValue(mockProcess);

      const result = await service.performUpdate();
      expect(result.success).toBe(true);
      expect(result.message).toContain('restart shortly');
    });
  });

  describe('getAutoUpdatesEnabled', () => {
    it('should default to true when no settings file exists', () => {
      expect(service.getAutoUpdatesEnabled()).toBe(true);
    });
  });

  describe('onApplicationBootstrap', () => {
    it('should not schedule auto-update in non-production', () => {
      service.onApplicationBootstrap();
      // No interval set in non-prod — just ensure no error
    });
  });
});
