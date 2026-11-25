import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerCpArchive } from './docker-cp-archive';

const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));
vi.mock('../env-file', () => ({ parseEnvFile: () => ({ POSTGRES_PASSWORD: 'from-env-file' }) }));

const { syncPostgresPasswordFromEnv, tcpProbeNetworks } = await import('../sync-postgres-password');

describe('tcpProbeNetworks', () => {
  it('probes from the network the database is actually on first (post-#1597: ci-hub_internal only)', () => {
    expect(tcpProbeNetworks(['ci-hub_internal'])[0]).toBe('ci-hub_internal');
  });

  it('still reaches an older stack whose database sits on the shared Hub networks', () => {
    const networks = tcpProbeNetworks(['ci-hub_network', 'ci-os-hub_network']);
    expect(networks.slice(0, 2)).toEqual(['ci-hub_network', 'ci-os-hub_network']);
    expect(networks).toContain('ci-hub_internal');
  });

  it('falls back to every known network, internal first, when the attachments cannot be read', () => {
    expect(tcpProbeNetworks([])).toEqual(['ci-hub_internal', 'ci-hub_network', 'ci-os-hub_network']);
  });

  it('lists each network once', () => {
    const networks = tcpProbeNetworks(['ci-hub_internal', 'ci-hub_network']);
    expect(new Set(networks).size).toBe(networks.length);
  });
});

type Result = { status: number | null; stdout: string | Buffer; stderr: string | Buffer };

const AUTH_FAILED =
  'psql: error: connection to server at "ci-hub-db" (10.128.0.11), port 6543 failed: FATAL:  password authentication failed for user "companion"';
/** What Docker 29.10 says for `docker run --network ci-hub_internal`, whose ip_range has no free address. */
const NO_ADDRESS =
  "docker: Error response from daemon: failed to set up container networking: no available IPv4 addresses on this network's address pools: ci-hub_internal (4a70)";

/**
 * A Docker engine running a healthy `ci-hub-db` on `networks`, whose role password is `password`.
 * `docker run` on `ci-hub_internal` fails as on a fresh install; `onRun` answers it elsewhere.
 * `lostExec` makes it the desktop app's WSL2 engine: a plain `docker exec` exits 0 and prints nothing.
 */
function engine(options: {
  password: string;
  networks?: string[];
  lostExec?: boolean;
  onRun?: (network: string) => Result;
  onExec?: (command: string[]) => Result | undefined;
}) {
  const state = { password: options.password };
  const outputByDir = new Map<string, Result>();

  /** Runs a command in ci-hub-db: a psql sign-in over TCP, or ALTER USER over the local socket. */
  const runInDb = (command: string[], env: NodeJS.ProcessEnv | undefined): Result => {
    if (command.includes('-h')) {
      return env?.PGPASSWORD === state.password ? { status: 0, stdout: '        1\n\n', stderr: '' } : { status: 2, stdout: '', stderr: AUTH_FAILED };
    }
    const sql = command[command.indexOf('-c') + 1] ?? '';
    const changed = /PASSWORD '(.*)';$/.exec(sql);
    if (changed?.[1] !== undefined) state.password = changed[1];
    return { status: 0, stdout: 'ALTER ROLE\n', stderr: '' };
  };

  spawnSync.mockImplementation((_command: string, args: string[], spawnOptions?: { env?: NodeJS.ProcessEnv }): Result => {
    const [verb] = args;
    if (verb === 'inspect') {
      const format = String(args[2]);
      if (format.includes('Running')) return { status: 0, stdout: 'true\n', stderr: '' };
      if (format.includes('Health')) return { status: 0, stdout: 'healthy\n', stderr: '' };
      return { status: 0, stdout: `${(options.networks ?? ['ci-hub_internal']).join('\n')}\n`, stderr: '' };
    }
    if (verb === 'run') {
      const network = args[args.indexOf('--network') + 1] ?? '';
      if (network === 'ci-hub_internal') return { status: 125, stdout: '', stderr: NO_ADDRESS };
      return options.onRun?.(network) ?? { status: 125, stdout: '', stderr: `docker: Error response from daemon: network ${network} not found` };
    }
    if (verb === 'exec' && args[1] === '-d') {
      // The copy route: `exec -d [-e NAME]... ci-hub-db sh -c <script> sh <dir> <command...>`, or its `rm -rf <dir>`.
      const script = args.indexOf('-c');
      if (script > 0) outputByDir.set(String(args[script + 3]), runInDb(args.slice(script + 4), spawnOptions?.env));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'cp') {
      const dir = String(args[1]).slice(String(args[1]).indexOf(':') + 1);
      const result = outputByDir.get(dir);
      if (!result) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const folder = dockerCpArchive(dir.split('/').pop() ?? '', {
        out: String(result.stdout),
        err: String(result.stderr),
        status: `${result.status ?? 1}\n`,
      });
      return { status: 0, stdout: folder, stderr: Buffer.alloc(0) };
    }
    if (verb === 'exec') {
      const override = options.onExec?.(args);
      if (override) return override;
      const result = runInDb(args.slice(args.indexOf('ci-hub-db') + 1), spawnOptions?.env);
      return options.lostExec ? { status: 0, stdout: '', stderr: '' } : result;
    }
    return { status: 1, stdout: '', stderr: `unexpected docker ${verb}` };
  });
  return state;
}

const dockerCalls = (): string[][] => spawnSync.mock.calls.map(([, args]) => args as string[]);
const signInCalls = () => dockerCalls().filter((args) => args.includes('-h'));
const containersStarted = () => dockerCalls().filter((args) => args[0] === 'run');
const alterUserCalls = () => dockerCalls().filter((args) => args.some((arg) => arg.startsWith('ALTER USER')));

describe('syncPostgresPasswordFromEnv', () => {
  let savedPassword: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedPassword = process.env.POSTGRES_PASSWORD;
    delete process.env.POSTGRES_PASSWORD;
    spawnSync.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedPassword === undefined) delete process.env.POSTGRES_PASSWORD;
    else process.env.POSTGRES_PASSWORD = savedPassword;
    logSpy.mockRestore();
  });

  const logged = () => (logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');

  /**
   * A fresh install: compose created ci-hub_internal with an ip_range that holds only the network
   * address and the gateway, so `docker run --network ci-hub_internal` gets no address, and the
   * shared networks don't exist yet. Checking from a throwaway client there failed `cihub up` with
   * "password sync did not fix TCP authentication".
   */
  it('finds the right password on a fresh install, where no container can join ci-hub_internal', async () => {
    engine({ password: 'from-env-file' });

    await syncPostgresPasswordFromEnv('.env');

    expect(logged()).toContain('Postgres password already matches env');
    expect(alterUserCalls()).toEqual([]);
    expect(containersStarted()).toEqual([]);
    expect(signInCalls()[0]?.slice(0, 2)).toEqual(['exec', '-e']);
  });

  it('changes a password that does not match, and checks it again from inside the database', async () => {
    const db = engine({ password: 'older-password' });

    await syncPostgresPasswordFromEnv('.env');

    expect(db.password).toBe('from-env-file');
    expect(alterUserCalls()).toHaveLength(1);
    expect(logged()).toContain('Postgres password synced successfully');
    expect(containersStarted()).toEqual([]);
  });

  it('signs in to the database by name, not over loopback, which Postgres trusts without a password', async () => {
    engine({ password: 'from-env-file' });

    await syncPostgresPasswordFromEnv('.env');

    const [signIn] = signInCalls();
    expect(signIn?.[signIn.indexOf('-h') + 1]).toBe('ci-hub-db');
  });

  it('keeps the password out of the sign-in arguments', async () => {
    engine({ password: 'older-password' });

    await syncPostgresPasswordFromEnv('.env');

    expect(signInCalls().length).toBeGreaterThan(0);
    for (const args of signInCalls()) expect(args.join(' ')).not.toContain('from-env-file');
  });

  /**
   * The desktop app's WSL2 engine: a plain `docker exec` exits 0 and prints nothing, whatever psql
   * did. Taking that as a sign-in would leave a wrong password in place and the Hub unable to start.
   */
  it('reads the answer back on an engine that loses docker exec output, so a wrong password still counts as wrong', async () => {
    const db = engine({ password: 'older-password', lostExec: true });

    await syncPostgresPasswordFromEnv('.env');

    expect(alterUserCalls()).toHaveLength(1);
    expect(db.password).toBe('from-env-file');
    expect(logged()).toContain('Postgres password synced successfully');
    expect(dockerCalls().some((args) => args[0] === 'cp')).toBe(true);
    expect(containersStarted()).toEqual([]);
  });

  it('waits for Postgres to take TCP connections instead of calling the password wrong', async () => {
    vi.useFakeTimers();
    try {
      let refusals = 2;
      engine({
        password: 'from-env-file',
        onExec: (args) =>
          args.includes('-h') && refusals-- > 0
            ? {
                status: 2,
                stdout: '',
                stderr: 'psql: error: connection to server at "ci-hub-db" (10.128.0.11), port 6543 failed: Connection refused',
              }
            : undefined,
      });

      const sync = syncPostgresPasswordFromEnv('.env');
      await vi.runAllTimersAsync();
      await sync;

      expect(logged()).toContain('Postgres password already matches env');
      expect(alterUserCalls()).toEqual([]);
      expect(containersStarted()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a client on the database networks when the check inside cannot run', async () => {
    const runs: string[] = [];
    engine({
      password: 'from-env-file',
      networks: ['ci-hub_network'],
      onExec: () => ({ status: 126, stdout: '', stderr: 'OCI runtime exec failed: exec failed: unable to start container process' }),
      onRun: (network) => {
        runs.push(network);
        return { status: 0, stdout: '1\n', stderr: '' };
      },
    });

    await syncPostgresPasswordFromEnv('.env');

    expect(runs).toEqual(['ci-hub_network']);
    expect(logged()).toContain('Postgres password already matches env');
  });

  it('does not try the networks when Postgres itself refused the password', async () => {
    engine({ password: 'older-password' });

    await syncPostgresPasswordFromEnv('.env');

    expect(containersStarted()).toEqual([]);
  });
});
