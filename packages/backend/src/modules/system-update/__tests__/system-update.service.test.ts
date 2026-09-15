import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { HUB_STACK_IMAGE_REPO, HUB_STACK_REGISTRY_REPO } from '@/common/constants';
import { isHubVersionTag, resolveHostListenerBaseUrl, SystemUpdateService } from '../system-update.service';
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
    it.each([
      {
        topology: 'canonical',
        hubContainerName: 'ci-hub',
        rabbitmqHost: 'ci-hub-queue',
        expectedServices: ['ci-hub', 'ci-hub-queue'],
      },
      {
        topology: 'legacy',
        hubContainerName: '',
        rabbitmqHost: 'ci-os-hub-queue',
        expectedServices: ['ci-os-hub', 'ci-os-hub-queue'],
      },
    ])('should pull the pinned Hub image and recreate the $topology services', async ({ hubContainerName, rabbitmqHost, expectedServices }) => {
      vi.useFakeTimers();
      vi.stubEnv('ROOT_FOLDER_HOST', '/host/companion-hub');
      vi.stubEnv('CI_HUB_IMAGE', `${HUB_STACK_IMAGE_REPO}:old`);
      vi.stubEnv('HUB_CONTAINER_NAME', hubContainerName);
      vi.stubEnv('RABBITMQ_HOST', rabbitmqHost);
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
      expect(upCall[1]).toContain('--remove-orphans');
      for (const service of expectedServices) {
        expect(upCall[1]).toContain(service);
      }
      expect(upCall[1]).toContain('--project-directory');
      expect(upCall[1]).toContain('/host/companion-hub');
      expect(upCall[2].env.CI_HUB_IMAGE).toBe(`${HUB_STACK_IMAGE_REPO}:1.1.0`);

      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it.each([
      '1.1.0\nCI_HUB_CLOUD_URL_OVERRIDE=https://attacker.example',
      '1.1.0\r\nCI_CLOUD_URL=https://attacker.example',
      '1.1.0 CI_HUB_VERSION=1.0.0',
      'latest',
      '1.1',
      '01.1.0',
      '',
    ])('refuses target version %j before it writes the env file or starts an update', async (targetVersion) => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:old\nCI_HUB_VERSION=old\n`);
      const { spawn } = await import('node:child_process');

      await expect(service.performUpdate(targetVersion)).rejects.toThrow(BadRequestException);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
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

  describe('isHubVersionTag', () => {
    it.each(['0.2.71', 'v0.2.71', 'V1.0.0', '0.2.72-rc.1', '1.0.0-beta.2'])('accepts %j', (tag) => {
      expect(isHubVersionTag(tag)).toBe(true);
    });

    it.each([
      '',
      'latest',
      'dev',
      '0.2',
      '01.2.3',
      '0.2.71+ci.7',
      '0.2.71-',
      '0.2.71\n',
      ' 0.2.71',
      '0.2.71\nCI_HUB_CLOUD_URL_OVERRIDE=https://attacker.example',
    ])('refuses %j', (tag) => {
      expect(isHubVersionTag(tag)).toBe(false);
    });
  });

  describe('Hub .env pinning', () => {
    it('refuses to write a value that contains a line break', () => {
      const upsert = (service as unknown as { upsertEnvLine(lines: string[], key: string, value: string): string[] }).upsertEnvLine.bind(service);

      expect(() => upsert(['CI_HUB_VERSION=old'], 'CI_HUB_VERSION', '1.1.0\nCI_HUB_CLOUD_URL_OVERRIDE=https://attacker.example')).toThrow(
        /line break/,
      );
      expect(() => upsert([], 'CI_HUB_VERSION', '1.1.0\r')).toThrow(/line break/);
      expect(upsert(['CI_HUB_VERSION=old'], 'CI_HUB_VERSION', '1.1.0')).toEqual(['CI_HUB_VERSION=1.1.0']);
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
