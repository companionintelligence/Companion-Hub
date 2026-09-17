import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { HUB_STACK_IMAGE_REPO, HUB_STACK_REGISTRY_REPO } from '@/common/constants';
import {
  buildStackUpdaterRunArgs,
  forwardableEnvKeys,
  isHubVersionTag,
  resolveHostListenerBaseUrl,
  shellQuote,
  stackUpdaterContainerName,
  SystemUpdateService,
} from '../system-update.service';
import fs from 'node:fs';
import axios from 'axios';

/** The two files `detectHubContainer` looks for. */
const isContainerMarker = (target: unknown) => /\/\.dockerenv$|\/run\/\.containerenv$/.test(String(target));

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
      // Not inside Docker: no /.dockerenv, so the recreate is spawned directly.
      vi.mocked(fs.existsSync).mockImplementation((target) => !isContainerMarker(target));
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

    // The failure this guards against is on record on every appliance that ever auto-updated:
    // `hub-stack-update.log` ends at `Container ci-hub  Recreate` and the Hub is down until an
    // operator runs `up` by hand (fzzy 2026-09-11 and 2026-09-15, beta-max 2026-09-11). A compose
    // client spawned inside the container it is recreating dies when compose stops that container.
    it('runs the recreate from a separate updater container when the Hub itself is in Docker', async () => {
      vi.useFakeTimers();
      vi.stubEnv('ROOT_FOLDER_HOST', '/host/companion-hub');
      vi.stubEnv('CI_HUB_IMAGE', `${HUB_STACK_IMAGE_REPO}:old`);
      vi.stubEnv('HUB_CONTAINER_NAME', 'ci-hub');
      vi.stubEnv('RABBITMQ_HOST', 'ci-hub-queue');
      vi.stubEnv('DOCKER_CONFIG', '/data/.docker');
      vi.mocked(fs.existsSync).mockImplementation(
        (target) => isContainerMarker(target) || String(target).endsWith('.env') || String(target).endsWith('.yml'),
      );
      vi.mocked(fs.readFileSync).mockReturnValue(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:old\nCI_HUB_VERSION=old\n`);

      const { spawn } = await import('node:child_process');
      const mockProcess = () => ({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'close') cb(0);
          if (event === 'spawn') cb();
        }),
        unref: vi.fn(),
      });
      (spawn as any).mockImplementation(() => mockProcess());

      const resultPromise = service.performUpdate('1.2.0');
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.stack).toBe('updating');

      // pull, rm (leftover helper), run — and never a bare `docker compose` from this process.
      const calls = (spawn as any).mock.calls as [string, string[], { env: NodeJS.ProcessEnv; detached?: boolean }][];
      expect(calls.map((call) => `${call[0]} ${call[1][0]}`)).toEqual(['docker pull', 'docker rm', 'docker run']);
      expect(calls.some((call) => call[2]?.detached)).toBe(false);

      const [, rmArgs] = calls[1];
      expect(rmArgs).toEqual(['rm', 'ci-hub-stack-updater']);

      const [, runArgs, runOpts] = calls[2];
      expect(runArgs.slice(0, 5)).toEqual(['run', '-d', '--rm', '--name', 'ci-hub-stack-updater']);
      expect(runArgs).toContain('--volumes-from');
      expect(runArgs[runArgs.indexOf('--volumes-from') + 1]).toBe('ci-hub');
      expect(runArgs[runArgs.indexOf('--network') + 1]).toBe('none');
      // The helper is the image just pulled — present by construction, and it ships the docker CLI.
      expect(runArgs[runArgs.indexOf('--entrypoint') + 2]).toBe(`${HUB_STACK_IMAGE_REPO}:1.2.0`);
      // Values reach the helper through the CLI's environment, never argv.
      expect(runArgs).toContain('-e');
      expect(runArgs).not.toContain(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:1.2.0`);
      expect(runArgs.filter((arg) => arg === 'CI_HUB_IMAGE')).toHaveLength(1);
      expect(runArgs.filter((arg) => arg === 'DOCKER_CONFIG')).toHaveLength(1);
      expect(runOpts.env.CI_HUB_IMAGE).toBe(`${HUB_STACK_IMAGE_REPO}:1.2.0`);

      const script = runArgs[runArgs.length - 1];
      expect(runArgs[runArgs.length - 2]).toBe('-c');
      expect(script).toMatch(/^exec 'docker' 'compose' /);
      for (const expected of ['--force-recreate', '--no-deps', '--remove-orphans', 'ci-hub', 'ci-hub-queue', '/host/companion-hub']) {
        expect(script).toContain(`'${expected}'`);
      }
      expect(script).toMatch(/ >> '\/data\/logs\/hub-stack-update\.log' 2>&1$/);

      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it('records a helper that could not start instead of failing silently', async () => {
      vi.useFakeTimers();
      vi.stubEnv('HUB_CONTAINER_NAME', 'ci-hub');
      vi.stubEnv('RABBITMQ_HOST', 'ci-hub-queue');
      vi.mocked(fs.existsSync).mockImplementation((target) => isContainerMarker(target));

      const { spawn } = await import('node:child_process');
      let runs = 0;
      (spawn as any).mockImplementation((_bin: string, args: string[]) => {
        const failing = args[0] === 'run' && ++runs === 1;
        return {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn((_event: string, cb: (data: Buffer) => void) => failing && cb(Buffer.from('conflict: name in use'))) },
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === 'close') cb(failing ? 125 : 0);
          }),
          unref: vi.fn(),
        };
      });

      const resultPromise = service.performUpdate('1.2.0');
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('ci-hub-stack-updater'), expect.any(Error));
      const appended = vi
        .mocked(fs.appendFileSync)
        .mock.calls.map((call) => String(call[1]))
        .join('');
      expect(appended).toContain('updater container failed to start');
      expect(appended).toContain('conflict: name in use');

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

  describe('setAutoUpdatesEnabled', () => {
    it('writes through the shared settings merge, so later settings writes cannot strip the key', async () => {
      // settings-round-trip.test.ts proves the merge keeps it. This pins that the switch uses it,
      // rather than a private read-modify-write that bypasses the schema.
      mockConfig.setFileOnlySettings = vi.fn().mockResolvedValue(undefined);

      await service.setAutoUpdatesEnabled(false);

      expect(mockConfig.setFileOnlySettings).toHaveBeenCalledWith({ autoUpdates: false });
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });

    it('refuses a string "false", which would read back as auto-update still on', async () => {
      mockConfig.setFileOnlySettings = vi.fn().mockResolvedValue(undefined);

      await expect(service.setAutoUpdatesEnabled('false' as unknown as boolean)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockConfig.setFileOnlySettings).not.toHaveBeenCalled();
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

  describe('stack updater container', () => {
    it('names the helper after the Hub container, legacy topology included', () => {
      expect(stackUpdaterContainerName({ HUB_CONTAINER_NAME: 'ci-hub' })).toBe('ci-hub-stack-updater');
      expect(stackUpdaterContainerName({ RABBITMQ_HOST: 'ci-os-hub-queue' })).toBe('ci-os-hub-stack-updater');
    });

    it('forwards compose-relevant env and drops the process-local names', () => {
      const keys = forwardableEnvKeys({
        ROOT_FOLDER_HOST: '/host',
        CI_HUB_IMAGE: 'img',
        DOCKER_CONFIG: '/data/.docker',
        JWT_SECRET: 's',
        PATH: '/usr/bin',
        HOME: '/root',
        HOSTNAME: 'abc',
        PWD: '/app',
        'not a key': 'x',
        UNSET: undefined,
      });
      expect(keys).toEqual(['CI_HUB_IMAGE', 'DOCKER_CONFIG', 'JWT_SECRET', 'ROOT_FOLDER_HOST']);
    });

    it('single-quotes for sh, including embedded quotes', () => {
      expect(shellQuote('plain')).toBe("'plain'");
      expect(shellQuote("it's")).toBe(`'it'\\''s'`);
      expect(shellQuote('$HOME `x` "y"')).toBe(`'$HOME \`x\` "y"'`);
    });

    it('builds a detached, socket-only run that inherits the Hub mounts and appends to the update log', () => {
      const args = buildStackUpdaterRunArgs({
        helperName: 'ci-hub-stack-updater',
        hubContainer: 'ci-hub',
        image: 'ghcr.io/companionintelligence/ci-hub:1.2.0',
        envKeys: ['CI_HUB_IMAGE', 'ROOT_FOLDER_HOST'],
        composeArgs: ['compose', '--env-file', '/data/.env', 'up', '-d', "it's"],
        logPath: '/data/logs/hub-stack-update.log',
      });
      expect(args).toEqual([
        'run',
        '-d',
        '--rm',
        '--name',
        'ci-hub-stack-updater',
        '--network',
        'none',
        '--volumes-from',
        'ci-hub',
        '-e',
        'CI_HUB_IMAGE',
        '-e',
        'ROOT_FOLDER_HOST',
        '--entrypoint',
        'sh',
        'ghcr.io/companionintelligence/ci-hub:1.2.0',
        '-c',
        `exec 'docker' 'compose' '--env-file' '/data/.env' 'up' '-d' 'it'\\''s' >> '/data/logs/hub-stack-update.log' 2>&1`,
      ]);
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
