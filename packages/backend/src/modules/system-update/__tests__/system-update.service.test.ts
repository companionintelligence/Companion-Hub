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
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
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
      getTagsSinceWithHubFallback: vi.fn(),
    };
    service = new SystemUpdateService(mockLogger as any, mockConfig as any, mockRegistryService as any);
  });

  describe('checkForUpdates', () => {
    it('should return update available when newer versions exist', async () => {
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['1.1.0']);

      const result = await service.checkForUpdates();
      expect(result.updateAvailable).toBe(true);
      expect(result.current).toBe('1.0.0');
      expect(result.latest).toBe('1.1.0');
      expect(mockRegistryService.getTagsSinceWithHubFallback).toHaveBeenCalledWith(HUB_STACK_REGISTRY_REPO, '1.0.0');
    });

    it('should return no update when no newer versions', async () => {
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue([]);

      const result = await service.checkForUpdates();
      expect(result.updateAvailable).toBe(false);
    });
  });

  describe('performUpdate', () => {
    it('should pull the Hub image and recreate ci-os-hub on restart', async () => {
      vi.useFakeTimers();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:old\nCI_HUB_VERSION=old\n`);
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.appendFileSync).mockImplementation(() => undefined);
      vi.mocked(fs.openSync).mockReturnValue(3);

      const { spawn } = await import('node:child_process');
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'close') cb(0);
          if (event === 'spawn') cb();
        }),
        unref: vi.fn(),
      };
      (spawn as any).mockReturnValue(mockProcess);

      const resultPromise = service.performUpdate('1.1.0');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string;
      expect(written).toContain(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:1.1.0`);
      expect(written).toContain('CI_HUB_VERSION=1.1.0');
      expect(spawn).toHaveBeenCalledTimes(2);

      const pullCall = (spawn as any).mock.calls[0];
      expect(pullCall[1]).toContain('pull');
      expect(pullCall[1]).toContain('ci-os-hub');

      const upCall = (spawn as any).mock.calls[1];
      expect(upCall[1]).toContain('up');
      expect(upCall[1]).toContain('--no-deps');
      expect(upCall[1]).toContain('ci-os-hub');

      vi.useRealTimers();
    });
  });

  describe('getAutoUpdatesEnabled', () => {
    it('should default to true when no settings file exists', () => {
      expect(service.getAutoUpdatesEnabled()).toBe(true);
    });
  });

  describe('getHostUpdateListenerToken', () => {
    it('should return token when token file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('secret-token\n');

      expect(service.getHostUpdateListenerToken()).toBe('secret-token');
    });

    it('should return null when token file is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(service.getHostUpdateListenerToken()).toBeNull();
    });
  });
});
