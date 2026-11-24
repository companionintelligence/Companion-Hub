import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copiedCommandFolder } from './docker-cp-archive';

const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));
vi.mock('../env-file', () => ({ parseEnvFile: () => ({ RABBITMQ_PASSWORD: 'from-env-file' }) }));

const { syncRabbitmqPasswordFromEnv } = await import('../sync-rabbitmq-password');

const dockerCalls = (): string[][] => spawnSync.mock.calls.map(([, args]) => args as string[]);
const rabbitmqctlVerbs = (): string[] =>
  dockerCalls().flatMap((args) => (args.includes('rabbitmqctl') ? [args[args.indexOf('rabbitmqctl') + 1] ?? ''] : []));

/** `docker inspect` for a running, healthy queue container. */
function inspected(args: string[]) {
  return { status: 0, stdout: String(args[2]).includes('Running') ? 'true\n' : 'healthy\n', stderr: '' };
}

describe('syncRabbitmqPasswordFromEnv', () => {
  let savedPassword: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedPassword = process.env.RABBITMQ_PASSWORD;
    delete process.env.RABBITMQ_PASSWORD;
    spawnSync.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedPassword === undefined) delete process.env.RABBITMQ_PASSWORD;
    else process.env.RABBITMQ_PASSWORD = savedPassword;
    logSpy.mockRestore();
  });

  const logged = () => (logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');

  /**
   * The Docker engine the Windows desktop app runs in WSL2: a plain `docker exec` exits 0 and prints
   * nothing whatever rabbitmqctl did, while `docker exec -d` and `docker cp` work. The queue still has
   * an older password, so `authenticate_user` with the env file's fails until `change_password` runs.
   */
  it('changes a password that does not match, though docker exec reports every rabbitmqctl call as a success', async () => {
    const commandByDir = new Map<string, string[]>();
    let changed = false;
    spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'inspect') return inspected(args);
      // `exec -d [-e NAME]... <container> sh -c <copy script> sh <dir> <command...>`
      const copyScript = args.indexOf('-c');
      if (args[0] === 'exec' && args[1] === '-d' && copyScript > 0) commandByDir.set(String(args[copyScript + 3]), args.slice(copyScript + 4));
      if (args[0] === 'cp') {
        const dir = String(args[1]).slice(String(args[1]).indexOf(':') + 1);
        const command = commandByDir.get(dir) ?? [];
        const verb = command[command.indexOf('rabbitmqctl') + 1];
        if (verb === 'change_password') changed = true;
        const status = verb === 'authenticate_user' && !changed ? 65 : 0;
        return { status: 0, stdout: copiedCommandFolder(dir.split('/').pop() ?? '', `${verb} ...`, status), stderr: Buffer.alloc(0) };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await syncRabbitmqPasswordFromEnv('.env');

    expect(rabbitmqctlVerbs()).toContain('change_password');
    expect(logged()).toContain('password synced');
    expect(dockerCalls().some((args) => args[0] === 'compose')).toBe(false);
  });

  it('on an engine that returns output, asks rabbitmqctl once and copies nothing', async () => {
    spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'inspect') return inspected(args);
      if (args[0] === 'exec') return { status: 0, stdout: 'Authenticating user "companion" ...\nSuccess\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    await syncRabbitmqPasswordFromEnv('.env');

    expect(rabbitmqctlVerbs()).toEqual(['authenticate_user']);
    expect(dockerCalls().some((args) => args[0] === 'cp' || args[1] === '-d')).toBe(false);
    expect(logged()).toContain('auth already matches');
  });
});

/*
 * The broker password reaches rabbitmqctl on stdin, through `docker exec -e` and the shell's printf
 * builtin, so `ps` on the host or in the container never shows it.
 */
describe('syncRabbitmqPasswordFromEnv keeps the password out of argv', () => {
  beforeEach(() => {
    delete process.env.RABBITMQ_PASSWORD;
    spawnSync.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('names the variable in argv and puts the value only in the docker CLI environment', async () => {
    let authenticated = false;
    spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'inspect') return inspected(args);
      if (args[0] === 'exec' && args.includes('change_password')) {
        authenticated = true;
        return { status: 0, stdout: 'Changing password for user "companion" ...\n', stderr: '' };
      }
      if (args[0] === 'exec') return { status: authenticated ? 0 : 65, stdout: 'Authenticating user "companion" ...\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    await syncRabbitmqPasswordFromEnv('.env');

    const rabbitmqctlCalls = spawnSync.mock.calls.filter(([, args]) => (args as string[]).includes('rabbitmqctl'));
    expect(rabbitmqctlCalls.map(([, args]) => (args as string[])[(args as string[]).indexOf('rabbitmqctl') + 1])).toEqual([
      'authenticate_user',
      'change_password',
      'authenticate_user',
    ]);
    for (const [, args, options] of rabbitmqctlCalls) {
      expect((args as string[]).join(' ')).not.toContain('from-env-file');
      expect((args as string[]).slice(0, 3)).toEqual(['exec', '-e', 'CIHUB_RABBITMQ_PASSWORD']);
      expect((args as string[]).at(-1)).toBe('companion');
      expect((options as { env: NodeJS.ProcessEnv }).env.CIHUB_RABBITMQ_PASSWORD).toBe('from-env-file');
    }
  });
});
