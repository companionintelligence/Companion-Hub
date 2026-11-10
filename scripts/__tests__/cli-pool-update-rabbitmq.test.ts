/**
 * `cihub pool update` and the broker password (Companion-Hub#884), driven through runPoolCommand.
 *
 * The prod compose requires RABBITMQ_PASSWORD from the env file, so a checkout node whose env file came
 * from `.env.example` (no RABBITMQ_PASSWORD) or still says `admin` must get one of its own before the
 * first `docker pull` or compose call, and the broker must be synced after `up`. Docker, git, the
 * health probe and the sync are stubbed; the env file is a real file in a temp folder.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as { kind: string; args: string[]; password: string | undefined }[]);
const state = vi.hoisted(() => ({ dir: '', envFile: '' }));

function passwordInEnvFile(): string | undefined {
  const line = readFileSync(state.envFile, 'utf-8')
    .split('\n')
    .filter((entry) => entry.startsWith('RABBITMQ_PASSWORD='))
    .at(-1);
  return line?.slice('RABBITMQ_PASSWORD='.length);
}

vi.mock('../lib/cli-proc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-proc.js')>()),
  run: vi.fn((cmd: string, args: string[]) => {
    events.push({ kind: cmd, args, password: passwordInEnvFile() });
  }),
  // Not a git checkout, and no running Hub container to read compose labels from.
  runCapture: vi.fn(() => ({ ok: false, stdout: '' })),
  runScript: vi.fn(async (_label: string, fn: () => unknown) => fn()),
}));

vi.mock('../sync-rabbitmq-password.js', () => ({
  syncRabbitmqPasswordFromEnv: vi.fn(async (envFile: string) => {
    events.push({ kind: 'sync', args: [envFile], password: passwordInEnvFile() });
  }),
}));

vi.mock('../lib/hub-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-context.js')>()),
  resolveHubContext: vi.fn(() => ({
    env: 'prod',
    appliance: false,
    envFile: state.envFile,
    composeFiles: ['docker-compose.prod.yml'],
    cwd: state.dir,
  })),
}));

vi.mock('../pool-diagnostics-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pool-diagnostics-cli.js')>()),
  readRunningImageIdentity: vi.fn(() => null),
}));

vi.mock('../lib/cli-version-skew.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-version-skew.js')>()),
  gatherSkew: vi.fn(() => ({ report: { severity: 'ok', headline: 'in step' }, channel: 'release', stack: null })),
}));

vi.mock('../lib/cli-ui.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-ui.js')>()),
  printMessageBox: vi.fn(),
}));

const { runPoolCommand } = await import('../lib/cli-pool.js');

beforeEach(() => {
  events.length = 0;
  state.dir = mkdtempSync(path.join(tmpdir(), 'pool-update-rabbitmq-'));
  state.envFile = path.join(state.dir, '.env.prod');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(state.dir, { recursive: true, force: true });
});

describe('cihub pool update', () => {
  it.each([
    ['no RABBITMQ_PASSWORD (copied from .env.example)', 'JWT_SECRET=jwt\nDOMAIN=example.com\n'],
    ['RABBITMQ_PASSWORD=admin', 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\nDOMAIN=example.com\n'],
  ])('from an env file with %s, writes a password before any pull and syncs the broker after up', async (_case, body) => {
    writeFileSync(state.envFile, body, { mode: 0o600 });

    await runPoolCommand(['update']);

    const docker = events.filter((event) => event.kind === 'docker');
    const firstPull = docker.findIndex((event) => event.args[0] === 'pull' || event.args.includes('pull'));
    const up = events.findIndex((event) => event.kind === 'docker' && event.args.includes('up'));
    const sync = events.findIndex((event) => event.kind === 'sync');
    expect(firstPull).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);

    const password = passwordInEnvFile();
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    // Every docker call, the first pull included, already saw the new password in the env file.
    for (const event of docker) expect(event.password).toBe(password);
    expect(sync).toBeGreaterThan(up);
    expect(events[sync]?.args).toEqual([state.envFile]);
    expect(events[sync]?.password).toBe(password);
    expect(readFileSync(state.envFile, 'utf-8').match(/^RABBITMQ_PASSWORD=/gm)).toHaveLength(1);
  });

  it('leaves a strong password alone, and does not sync a broker it did not change', async () => {
    writeFileSync(state.envFile, 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

    await runPoolCommand(['update']);

    expect(passwordInEnvFile()).toBe('already-strong');
    expect(events.some((event) => event.kind === 'docker' && event.args.includes('up'))).toBe(true);
    expect(events.some((event) => event.kind === 'sync')).toBe(false);
  });
});
