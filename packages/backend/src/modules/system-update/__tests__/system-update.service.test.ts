import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { HUB_STACK_IMAGE_REPO, HUB_STACK_REGISTRY_REPO } from '@/common/constants';
import { resolveHostListenerBaseUrl, SystemUpdateService } from '../system-update.service';
import { ENV_RESTORE_VARIABLE } from '../stack-updater';
import type { DockerContainerInspect } from '../hub-deployment';
import { core14HybridCheckout, core3EnvLabelDiffersFromMount, core4SourceCheckout, core6Appliance } from './fleet-hub-inspect.fixtures';
import { spawn } from 'node:child_process';
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
    fstatSync: vi.fn(),
    closeSync: vi.fn(),
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0o400000, O_NONBLOCK: 0o4000 },
    promises: { writeFile: vi.fn() },
  },
}));

const RELEASE_PIN = `${HUB_STACK_IMAGE_REPO}:0.2.70`;
const DEV_CHANNEL = `${HUB_STACK_IMAGE_REPO}:dev`;
const PINNED_ENV = `JWT_SECRET=secret\nCI_HUB_IMAGE=${RELEASE_PIN}\nCI_HUB_VERSION=0.2.70\n`;

type SpawnCall = [string, string[], { env: NodeJS.ProcessEnv }];

/**
 * The Docker CLI as the Hub container sees it: `inspect` answers with a recorded fleet container, every
 * other command succeeds unless `failing` names it. What is under test is the service, not Docker.
 */
async function installDocker(container: DockerContainerInspect, options: { failing?: string; stderr?: string; repoTags?: string[] } = {}) {
  const { spawn } = await import('node:child_process');
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    const failing = args[0] === options.failing;
    const stdout =
      args[0] === 'inspect'
        ? JSON.stringify([container])
        : args[0] === 'image'
          ? JSON.stringify([{ RepoTags: options.repoTags ?? [container.Config?.Image] }])
          : '';
    return {
      stdout: { on: vi.fn((_event: string, cb: (data: Buffer) => void) => stdout && cb(Buffer.from(stdout))) },
      stderr: { on: vi.fn((_event: string, cb: (data: Buffer) => void) => failing && cb(Buffer.from(options.stderr ?? 'boom'))) },
      on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'close') cb(failing ? 125 : 0);
      }),
      unref: vi.fn(),
    };
  }) as never);
  return vi.mocked(spawn).mock.calls as unknown as SpawnCall[];
}

/** Inside the Hub container, with this env file at /data/.env and no desktop listener token. */
function insideHubContainer(envContent: string) {
  vi.mocked(fs.existsSync).mockImplementation((target) => {
    const p = String(target);
    return p === '/.dockerenv' || p === '/data/.env';
  });
  vi.mocked(fs.readFileSync).mockImplementation(((target: unknown) => {
    if (String(target) === '/data/.env') return envContent;
    throw new Error(`unexpected read of ${String(target)}`);
  }) as never);
}

/** The desktop listener token in state/, as the desktop app writes it: a small regular file. */
function withListenerToken() {
  vi.mocked(fs.openSync).mockImplementation(((target: unknown) => (String(target) === '/data/state/update-listener.token' ? 7 : 3)) as never);
  vi.mocked(fs.fstatSync).mockImplementation(((fd: number) => ({ isFile: () => fd === 7, size: 32 })) as never);
}

describe('SystemUpdateService', () => {
  let service: SystemUpdateService;
  let mockRegistryService: { getTagsSinceWithHubFallback: ReturnType<typeof vi.fn> };
  let mockConfig: { getConfig: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let mockLogger: Record<'info' | 'debug' | 'error' | 'warn', ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReset().mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.openSync).mockReset().mockReturnValue(3);
    vi.mocked(fs.fstatSync).mockReset();
    vi.mocked(axios.get).mockRejectedValue(new Error('listener down'));
    vi.mocked(axios.post).mockRejectedValue(new Error('listener down'));
    mockLogger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
    // CI_HUB_VERSION as beta-red had it. Nothing below may read it.
    mockConfig = {
      getConfig: vi.fn(() => ({ __prod__: false, version: 'v0.2.22' })),
      get: vi.fn(() => ({ dataDir: '/data' })),
    };
    mockRegistryService = { getTagsSinceWithHubFallback: vi.fn().mockResolvedValue([]) };
    service = new SystemUpdateService(mockLogger as never, mockConfig as never, mockRegistryService as never);
    vi.stubEnv('CI_HUB_VERSION', 'v0.2.22');
    vi.stubEnv('DOCKER_CONFIG', '/data/.docker');
    vi.stubEnv('ROOT_FOLDER_HOST', '/home/ci/.local/share/companion-hub');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('checkForUpdates', () => {
    it('compares the running release pin, not CI_HUB_VERSION, against the registry', async () => {
      insideHubContainer(PINNED_ENV);
      await installDocker(core6Appliance(RELEASE_PIN));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.72-rc.1', '0.2.71']);

      const result = await service.checkForUpdates();

      expect(mockRegistryService.getTagsSinceWithHubFallback).toHaveBeenCalledWith(HUB_STACK_REGISTRY_REPO, '0.2.70');
      expect(result).toMatchObject({ current: '0.2.70', latest: '0.2.71', updateAvailable: true, updateBlockedReason: null });
      expect(result.build).toMatchObject({ reference: RELEASE_PIN, version: '0.2.70', channel: 'pin' });
    });

    // beta-red: CI_HUB_VERSION=v0.2.22 on a dev build newer than 0.2.71. The old check listed every
    // release since 0.2.22 and offered to "update" it onto 0.2.71.
    it('offers no update to a dev-channel node, whatever CI_HUB_VERSION says', async () => {
      insideHubContainer(`CI_HUB_IMAGE=${DEV_CHANNEL}\nCI_HUB_VERSION=v0.2.22\n`);
      await installDocker(core6Appliance(DEV_CHANNEL));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.71']);

      const result = await service.checkForUpdates();

      expect(result.updateAvailable).toBe(false);
      expect(result.current).toBe('dev@dac546bcf');
      expect(result.updateBlockedReason).toContain("floating 'dev' tag");
      expect(mockRegistryService.getTagsSinceWithHubFallback).not.toHaveBeenCalled();
    });

    // core-3 on a release pin: performUpdate would 409 on the env-file mismatch, so offering the update
    // meant a daily failed auto-update and a Settings button that could never work.
    it('offers no update to a release pin whose stack the updater cannot reproduce, and says why', async () => {
      insideHubContainer(PINNED_ENV);
      await installDocker(core3EnvLabelDiffersFromMount(RELEASE_PIN));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.71']);

      const result = await service.checkForUpdates();

      expect(result).toMatchObject({ current: '0.2.70', updateAvailable: false });
      expect(result.updateBlockedReason).toContain('/home/ci/.local/share/companion-hub/.env.dev');
    });

    it('still offers that update when the desktop host listener will take it instead of compose', async () => {
      insideHubContainer(PINNED_ENV);
      withListenerToken();
      vi.mocked(fs.readFileSync).mockImplementation(((target: unknown) =>
        String(target) === '/data/.env' ? PINNED_ENV : 'listener-token\n') as never);
      vi.mocked(axios.get).mockResolvedValue({ status: 200 });
      await installDocker(core3EnvLabelDiffersFromMount(RELEASE_PIN));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.71']);

      const result = await service.checkForUpdates();

      expect(result).toMatchObject({ latest: '0.2.71', updateAvailable: true, updateBlockedReason: null });
    });

    it('says the build is unknown outside a container instead of reporting CI_HUB_VERSION', async () => {
      const result = await service.checkForUpdates();

      expect(result).toMatchObject({ current: 'unknown', updateAvailable: false, build: null });
      expect(result.updateBlockedReason).toContain('not running in a container');
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
    // core-2, core-4, core-6, core-17, beta-red and beta-max: the daily check rewrote CI_HUB_IMAGE=…:dev
    // to …:0.2.71 and pulled each node off the channel its operator chose.
    it.each([
      ['core-4', core4SourceCheckout()],
      ['core-14', core14HybridCheckout()],
      ['core-6', core6Appliance()],
    ])('leaves %s on :dev: no env write, no pull, no recreate', async (_node, container) => {
      insideHubContainer(`CI_HUB_IMAGE=${DEV_CHANNEL}\n`);
      const calls = await installDocker(container);

      await expect(service.performUpdate('0.2.71')).rejects.toThrow(ConflictException);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(calls.map((call) => call[1][0])).toEqual(['inspect', 'image']);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('refuses outside a container before touching anything', async () => {
      const calls = await installDocker(core6Appliance(RELEASE_PIN));

      await expect(service.performUpdate('0.2.71')).rejects.toThrow(/not running in a container/);
      expect(calls).toHaveLength(0);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // core-4: `--project-directory $ROOT_FOLDER_HOST` with ENV_FILE=.env made compose look for
    // /home/ci/devel/CI-Hub/.internal/.env, after it had already recreated the queue.
    it('recreates only the Hub service of a source checkout, from the files and env file compose used', async () => {
      vi.stubEnv('ROOT_FOLDER_HOST', '/home/ci/devel/CI-Hub/.internal');
      insideHubContainer(PINNED_ENV);
      const calls = await installDocker(core4SourceCheckout(RELEASE_PIN));

      const result = await service.performUpdate('v0.2.71');

      expect(result).toEqual({ success: true, message: 'Update initiated, hub will restart shortly', stack: 'updating', host: 'unavailable' });
      expect(calls.map((call) => call[1][0])).toEqual(['inspect', 'image', 'pull', 'rm', 'run']);
      expect(calls[2]?.[1]).toEqual(['pull', `${HUB_STACK_IMAGE_REPO}:0.2.71`]);
      expect(calls[3]?.[1]).toEqual(['rm', 'ci-os-hub-stack-updater']);

      const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
      expect(written).toContain(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:0.2.71`);
      expect(written).toContain('CI_HUB_VERSION=0.2.71');
      // The pull happened before the pin: a registry failure must leave the file as it was.
      const pullOrder = vi.mocked(spawn).mock.invocationCallOrder[2];
      expect(pullOrder).toBeDefined();
      expect(vi.mocked(fs.writeFileSync).mock.invocationCallOrder[0]).toBeGreaterThan(pullOrder as number);

      const [, runArgs, runOpts] = calls[4] as SpawnCall;
      expect(runArgs.slice(0, 9)).toEqual([
        'run',
        '-d',
        '--rm',
        '--name',
        'ci-os-hub-stack-updater',
        '--network',
        'none',
        '--volumes-from',
        'ci-os-hub',
      ]);
      expect(runArgs).toContain('type=bind,source=/home/ci/devel/CI-Hub,target=/home/ci/devel/CI-Hub,readonly');
      // Only the restore payload rides in the helper's environment, and never as a value in argv.
      expect(runArgs.filter((arg) => arg === '-e')).toHaveLength(1);
      expect(runArgs[runArgs.indexOf('-e') + 1]).toBe(ENV_RESTORE_VARIABLE);
      expect(Buffer.from(runOpts.env[ENV_RESTORE_VARIABLE] as string, 'base64').toString('utf8')).toBe(PINNED_ENV);
      expect(runArgs.join(' ')).not.toContain('secret');

      const script = runArgs.at(-1) as string;
      expect(script).toContain("'ENV_FILE=/home/ci/devel/CI-Hub/.env.prod'");
      expect(script).toContain("'COMPOSE_FILE_HOST=/home/ci/devel/CI-Hub/docker-compose.prod.yml'");
      expect(script).toContain(
        "'--project-name' 'ci-hub' '--project-directory' '/home/ci/devel/CI-Hub' '-f' '/home/ci/devel/CI-Hub/docker-compose.prod.yml' '--env-file' '/home/ci/devel/CI-Hub/.env.prod'",
      );
      expect(script).toContain("up -d --no-deps --force-recreate --no-build 'ci-os-hub'");
      expect(script).not.toContain('ci-os-hub-queue');
      expect(script).not.toContain('--remove-orphans');
      expect(script).not.toContain('.internal/.env');
      // The env file sets no ROOT_FOLDER_HOST, so the value this container was created with is passed on.
      expect(script).toContain("'ROOT_FOLDER_HOST=/home/ci/devel/CI-Hub/.internal'");
      expect(script).toMatch(/^exec >> '\/data\/logs\/hub-stack-update\.log' 2>&1\nsleep 3\n/);
    });

    it('refuses a stack it cannot reproduce before pinning or pulling', async () => {
      const container = core14HybridCheckout(RELEASE_PIN);
      container.Config = {
        ...container.Config,
        Labels: { ...container.Config?.Labels, 'com.docker.compose.project.environment_file': '/home/ci/devel/CI-Hub/.env.dev' },
      };
      insideHubContainer(PINNED_ENV);
      const calls = await installDocker(container);

      await expect(service.performUpdate('0.2.71')).rejects.toThrow(/--env-file \/home\/ci\/devel\/CI-Hub\/\.env\.dev/);

      expect(calls.map((call) => call[1][0])).toEqual(['inspect', 'image']);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('puts the old pin back and fails the request when the helper cannot start', async () => {
      insideHubContainer(PINNED_ENV);
      await installDocker(core6Appliance(RELEASE_PIN), { failing: 'run', stderr: 'conflict: name in use' });

      await expect(service.performUpdate('0.2.71')).rejects.toThrow(InternalServerErrorException);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('ci-hub-stack-updater'), expect.any(Error));
      const appended = vi
        .mocked(fs.appendFileSync)
        .mock.calls.map((call) => String(call[1]))
        .join('');
      expect(appended).toContain('updater container failed to start');
      expect(appended).toContain('conflict: name in use');
      expect(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]).toBe(PINNED_ENV);
    });

    it('leaves the env file alone when the pull fails', async () => {
      insideHubContainer(PINNED_ENV);
      await installDocker(core6Appliance(RELEASE_PIN), { failing: 'pull' });

      await expect(service.performUpdate('0.2.71')).rejects.toThrow(/docker exited with code 125/);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('updates to the newest release when no target is given', async () => {
      insideHubContainer(PINNED_ENV);
      const calls = await installDocker(core6Appliance(RELEASE_PIN));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.73-rc.1', '0.2.72', '0.2.71']);

      await service.performUpdate();

      expect(calls[2]?.[1]).toEqual(['pull', `${HUB_STACK_IMAGE_REPO}:0.2.72`]);
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
      insideHubContainer(PINNED_ENV);
      const calls = await installDocker(core6Appliance(RELEASE_PIN));

      await expect(service.performUpdate(targetVersion)).rejects.toThrow(BadRequestException);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });

    it('skips compose recreate when the host listener accepts the update', async () => {
      insideHubContainer(PINNED_ENV);
      withListenerToken();
      vi.mocked(fs.readFileSync).mockImplementation(((target: unknown) =>
        String(target) === '/data/.env' ? PINNED_ENV : 'listener-token\n') as never);
      vi.mocked(axios.get).mockResolvedValue({ status: 200 });
      vi.mocked(axios.post).mockResolvedValue({ status: 200 });
      const calls = await installDocker(core6Appliance(RELEASE_PIN));

      const result = await service.performUpdate('0.2.71');

      expect(result).toEqual({ success: true, message: 'Update initiated, hub will restart shortly', stack: 'skipped', host: 'started' });
      expect(calls.map((call) => call[1][0])).toEqual(['inspect', 'image']);
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringMatching(/\/update$/),
        null,
        expect.objectContaining({ headers: { Authorization: 'Bearer listener-token' } }),
      );
      expect(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]).toContain(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:0.2.71`);
    });

    it('puts the pin back when the listener fails and the stack cannot be reproduced either', async () => {
      const container = core6Appliance(RELEASE_PIN);
      container.Config = { ...container.Config, Labels: { 'org.opencontainers.image.version': 'latest' } };
      insideHubContainer(PINNED_ENV);
      withListenerToken();
      vi.mocked(fs.readFileSync).mockImplementation(((target: unknown) =>
        String(target) === '/data/.env' ? PINNED_ENV : 'listener-token\n') as never);
      vi.mocked(axios.get).mockResolvedValue({ status: 200 });
      vi.mocked(axios.post).mockResolvedValue({ status: 500 });
      await installDocker(container);

      await expect(service.performUpdate('0.2.71')).rejects.toThrow(/no docker compose project or service label/);
      expect(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]).toBe(PINNED_ENV);
    });

    it('treats a probe timeout as an unavailable host listener', async () => {
      withListenerToken();
      vi.mocked(fs.readFileSync).mockReturnValue('listener-token\n');
      vi.mocked(axios.get).mockRejectedValue(new Error('timeout'));

      await expect(service.probeHostListener()).resolves.toBe(false);
      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: false });
      expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), expect.anything());
    });
  });

  describe('scheduled auto-update', () => {
    const runCheck = (s: SystemUpdateService) => (s as unknown as { autoUpdateCheck(): Promise<void> }).autoUpdateCheck();

    it('does not update a node whose operator turned auto-update off', async () => {
      insideHubContainer(PINNED_ENV);
      vi.mocked(fs.existsSync).mockImplementation((target) => ['/.dockerenv', '/data/.env', '/data/state/settings.json'].includes(String(target)));
      vi.mocked(fs.readFileSync).mockImplementation(((target: unknown) =>
        String(target) === '/data/.env' ? PINNED_ENV : JSON.stringify({ autoUpdates: false })) as never);
      await installDocker(core6Appliance(RELEASE_PIN));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.71']);
      const perform = vi.spyOn(service, 'performUpdate');

      await runCheck(service);

      expect(perform).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('autoUpdates is off for this node'));
    });

    it('never runs an update on a dev-channel node, even with auto-update on', async () => {
      insideHubContainer(`CI_HUB_IMAGE=${DEV_CHANNEL}\n`);
      await installDocker(core6Appliance(DEV_CHANNEL));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.71']);
      const perform = vi.spyOn(service, 'performUpdate');

      await runCheck(service);

      expect(perform).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('skips, rather than fails, a release pin whose stack the updater cannot reproduce', async () => {
      insideHubContainer(PINNED_ENV);
      await installDocker(core3EnvLabelDiffersFromMount(RELEASE_PIN));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.71']);
      const perform = vi.spyOn(service, 'performUpdate');

      await runCheck(service);

      expect(perform).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/^Auto-update skipped: .*\.env\.dev/));
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('advances a release pin when a newer release exists and auto-update is on', async () => {
      insideHubContainer(PINNED_ENV);
      await installDocker(core6Appliance(RELEASE_PIN));
      mockRegistryService.getTagsSinceWithHubFallback.mockResolvedValue(['0.2.71']);
      const perform = vi.spyOn(service, 'performUpdate').mockResolvedValue({ success: true, message: '', stack: 'updating', host: 'unavailable' });

      await runCheck(service);

      expect(perform).toHaveBeenCalledWith('0.2.71');
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
    // A string "false" was persisted as-is and read back as "on", so the node kept auto-updating.
    // That the switch survives other settings writes, and cannot erase the Portal credential, is
    // proved against the real merge in core/config/__tests__/settings-round-trip.test.ts.
    it.each(['false', 0, null, undefined])('refuses %j instead of storing a value that reads as on', async (enabled) => {
      mockConfig.setFileOnlySettings = vi.fn().mockResolvedValue(undefined);

      await expect(service.setAutoUpdatesEnabled(enabled as never)).rejects.toThrow(BadRequestException);
      expect(mockConfig.setFileOnlySettings).not.toHaveBeenCalled();
    });
  });

  // The Hub container mounts the desktop data folder's `state/` at /data/state, never its root, so
  // a token only at the root is invisible to a containerized Hub (#1694).
  describe('getHostListenerStatus', () => {
    const STATE_TOKEN = '/data/state/update-listener.token';
    const ROOT_TOKEN = '/data/update-listener.token';

    const SYMLINK = '<symlink>';
    const FOLDER = '<folder>';
    const FIFO = '<fifo>';
    /** The flags each path was opened with. */
    const openFlags = new Map<string, number>();

    /** Only these exist: each is a regular file holding that text, or stands in for a symlink or a folder. */
    function withFiles(files: Record<string, string>) {
      const openFiles = new Map<number, string>();
      openFlags.clear();
      vi.mocked(fs.openSync).mockImplementation(((target: unknown, flags: unknown) => {
        openFlags.set(String(target), Number(flags));
        const entry = files[String(target)];
        if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${String(target)}`), { code: 'ENOENT' });
        // What the kernel does when O_NOFOLLOW meets a symlink.
        if (entry === SYMLINK && Number(flags) & fs.constants.O_NOFOLLOW) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
        const fd = 100 + openFiles.size;
        openFiles.set(fd, String(target));
        return fd;
      }) as never);
      vi.mocked(fs.fstatSync).mockImplementation(((fd: number) => {
        const entry = files[openFiles.get(fd) ?? ''] ?? '';
        const isFile = entry !== FOLDER && entry !== FIFO;
        return { isFile: () => isFile, size: isFile ? Buffer.byteLength(entry) : 0 };
      }) as never);
      vi.mocked(fs.readFileSync).mockImplementation(((fd: unknown) => {
        const entry = files[openFiles.get(Number(fd)) ?? ''];
        if (entry === undefined || entry === FOLDER || entry === FIFO) throw new Error(`unexpected read of ${String(fd)}`);
        return entry === SYMLINK ? 'a-secret-in-the-file-the-symlink-points-at\n' : entry;
      }) as never);
    }
    const expectSentToken = (token: string) =>
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringMatching(/\/health$/),
        expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } }),
      );

    beforeEach(() => {
      vi.mocked(axios.get).mockResolvedValue({ status: 200 });
    });

    it('reaches the listener with the token the desktop app keeps in state/', async () => {
      withFiles({ [STATE_TOKEN]: 'state-token\n' });

      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: true });
      expectSentToken('state-token');
    });

    it('prefers state/ over a token an older desktop build left at the data folder root', async () => {
      withFiles({ [STATE_TOKEN]: 'state-token\n', [ROOT_TOKEN]: 'legacy-token\n' });

      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: true });
      expectSentToken('state-token');
    });

    it('falls back to the data folder root, where older desktop builds wrote the token', async () => {
      withFiles({ [ROOT_TOKEN]: 'legacy-token\n' });

      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: true });
      expectSentToken('legacy-token');
    });

    it('reports the listener unreachable, without calling it, when neither file exists', async () => {
      withFiles({});

      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: false });
      expect(axios.get).not.toHaveBeenCalled();
    });

    // state/ is a host folder, and the Hub sends what it reads there to whoever answers on the
    // listener port, so a symlink put in the token's place must not make it send another file.
    it('does not follow a symlink in place of the token', async () => {
      withFiles({ [STATE_TOKEN]: SYMLINK });

      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: false });
      expect(axios.get).not.toHaveBeenCalled();
    });

    // Opening a FIFO for reading waits for a writer, and this runs on the Hub's event loop.
    it('does not wait on a FIFO in place of the token', async () => {
      withFiles({ [STATE_TOKEN]: FIFO });

      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: false });
      expect((openFlags.get(STATE_TOKEN) ?? 0) & fs.constants.O_NONBLOCK).not.toBe(0);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it.each([
      ['a folder', FOLDER],
      ['more than one word', 'two words\n'],
      ['far more than a token', `${'a'.repeat(2048)}\n`],
      ['an empty file', '\n'],
    ])('does not send %s as the token', async (_name, entry) => {
      withFiles({ [STATE_TOKEN]: entry });

      await expect(service.getHostListenerStatus()).resolves.toEqual({ reachable: false });
      expect(axios.get).not.toHaveBeenCalled();
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
