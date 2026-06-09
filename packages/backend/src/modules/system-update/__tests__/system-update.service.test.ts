import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HUB_STACK_IMAGE_REPO, HUB_STACK_REGISTRY_REPO } from '@/common/constants';
import { SystemUpdateService } from '../system-update.service';
import fs from 'node:fs';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    promises: { writeFile: vi.fn() },
  },
}));

describe('SystemUpdateService', () => {
  let service: SystemUpdateService;
  let mockRegistryService: any;
  let mockConfig: any;
  let mockLogger: any;

  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(mockRegistryService.getTagsSince).toHaveBeenCalledWith(HUB_STACK_REGISTRY_REPO, '1.0.0');
    });

    it('should return no update when no newer versions', async () => {
      mockRegistryService.getTagsSince.mockResolvedValue([]);

      const result = await service.checkForUpdates();
      expect(result.updateAvailable).toBe(false);
    });
  });

  describe('performUpdate', () => {
    it('should pull the full stack and recreate containers on restart', async () => {
      vi.useFakeTimers();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:old\n`);

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

      const resultPromise = service.performUpdate('1.1.0');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(2);

      const pullCall = (spawn as any).mock.calls[0];
      expect(pullCall[1]).toContain('pull');
      expect(pullCall[1]).not.toContain('ci-os-hub');

      const upCall = (spawn as any).mock.calls[1];
      expect(upCall[1]).toContain('up');
      expect(upCall[1]).toContain('--pull');
      expect(upCall[1]).toContain('always');
      expect(upCall[1]).toContain('--force-recreate');
      expect(upCall[1]).toContain('--remove-orphans');

      vi.useRealTimers();
    });
  });

  describe('getAutoUpdatesEnabled', () => {
    it('should default to true when no settings file exists', () => {
      expect(service.getAutoUpdatesEnabled()).toBe(true);
    });
  });
});
