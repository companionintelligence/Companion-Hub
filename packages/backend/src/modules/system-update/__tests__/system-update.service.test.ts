import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HUB_STACK_IMAGE_REPO, HUB_STACK_REGISTRY_REPO } from '@/common/constants';
import { resolveHostListenerBaseUrl, SystemUpdateService } from '../system-update.service';
import fs from 'node:fs';
import axios from 'axios';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
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
    vi.mocked(axios.get).mockRejectedValue(new Error('listener down'));
    vi.mocked(axios.post).mockRejectedValue(new Error('listener down'));
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

  describe('resolveHostListenerBaseUrl', () => {
    it('uses host.docker.internal from inside the Hub container', () => {
      expect(resolveHostListenerBaseUrl(true)).toBe('http://host.docker.internal:17400');
    });

    it('uses loopback when Hub is not in a container', () => {
      expect(resolveHostListenerBaseUrl(false)).toBe('http://127.0.0.1:17400');
    });
  });

  describe('performUpdate', () => {
    it('should pull the pinned Hub image and recreate ci-hub', async () => {
      vi.useFakeTimers();
      vi.stubEnv('ROOT_FOLDER_HOST', '/host/companion-hub');
      vi.stubEnv('CI_HUB_IMAGE', `${HUB_STACK_IMAGE_REPO}:old`);
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

      const resultPromise = service.performUpdate('v1.1.0');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.stack).toBe('updating');
      expect(result.host).toBe('unavailable');
      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string;
      expect(written).toContain(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:1.1.0`);
      expect(written).toContain('CI_HUB_VERSION=1.1.0');
      expect(spawn).toHaveBeenCalledTimes(2);

      const pullCall = (spawn as any).mock.calls[0];
      expect(pullCall[0]).toBe('docker');
      expect(pullCall[1]).toEqual(['pull', `${HUB_STACK_IMAGE_REPO}:1.1.0`]);
      expect(pullCall[2].env.CI_HUB_IMAGE).toBe(`${HUB_STACK_IMAGE_REPO}:1.1.0`);

      const upCall = (spawn as any).mock.calls[1];
      // The binary must be `docker` exactly once: a duplicated `docker` in argv
      // makes the CLI reject `--env-file` and the restart never runs (the
      // 0.2.44–0.2.46 stack-update regression).
      expect(upCall[0]).toBe('docker');
      expect(upCall[1][0]).toBe('compose');
      expect(upCall[1]).not.toContain('docker');
      expect(upCall[1]).toContain('up');
      expect(upCall[1]).toContain('--pull');
      expect(upCall[1]).toContain('always');
      expect(upCall[1]).toContain('--force-recreate');
      expect(upCall[1]).toContain('--no-deps');
      expect(upCall[1]).toContain('ci-hub');
      expect(upCall[1]).toContain('--project-directory');
      expect(upCall[1]).toContain('/host/companion-hub');
      expect(upCall[2].env.CI_HUB_IMAGE).toBe(`${HUB_STACK_IMAGE_REPO}:1.1.0`);

      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it('skips compose recreate when the host listener accepts the update', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('listener-token\n');
      vi.mocked(axios.get).mockResolvedValue({ status: 200 });
      vi.mocked(axios.post).mockResolvedValue({ status: 200 });

      const { spawn } = await import('node:child_process');
      const result = await service.performUpdate('1.1.0');

      expect(result).toEqual({
        success: true,
        message: 'Update initiated, hub will restart shortly',
        stack: 'skipped',
        host: 'started',
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringMatching(/\/update$/),
        null,
        expect.objectContaining({
          headers: { Authorization: 'Bearer listener-token' },
        }),
      );
    });

    it('treats a probe timeout as an unavailable host listener', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('listener-token\n');
      vi.mocked(axios.get).mockRejectedValue(new Error('timeout'));

      await expect(service.probeHostListener()).resolves.toBe(false);
      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: false });
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

  // Asserted against literals, not the constants themselves: the other tests interpolate
  // HUB_STACK_IMAGE_REPO and so would follow a bad edit silently. Pinning this image at the
  // private ci-os-hub package is what stopped Hub 0.2.44 from starting (#920), and it must
  // stay in step with HUB_STACK_IMAGE_REPO in the desktop's hub_env.rs.
  describe('Hub stack repo contract', () => {
    it('pulls from the public ci-hub GHCR package', () => {
      expect(HUB_STACK_IMAGE_REPO).toBe('ghcr.io/companionintelligence/ci-hub');
      expect(HUB_STACK_IMAGE_REPO).not.toContain('ci-os-hub');
    });

    it('lists versions from the Portal ci-hub path, not the retired ci-os-hub package', () => {
      // Same package name as GHCR, different registry. The retired ci-os-hub GHCR
      // package must not appear here — that is what broke Hub 0.2.44 (#920).
      expect(HUB_STACK_REGISTRY_REPO).toBe('ci-hub');
      expect(HUB_STACK_REGISTRY_REPO).not.toContain('ghcr.io');
      expect(HUB_STACK_REGISTRY_REPO).not.toContain('ci-os-hub');
    });
  });
});
