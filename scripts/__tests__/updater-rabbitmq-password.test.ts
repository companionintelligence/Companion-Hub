/**
 * scripts/updater/rabbitmq-password.sh, run for real against a stub `docker` on PATH (Companion-Hub#884).
 *
 * update.sh sources it to give the env file a broker password other than `admin` before compose reads
 * it, and to check the broker accepts that password after `up`. The stub keeps the broker's password in
 * a file, reads rabbitmqctl's password from stdin as the real one does, and logs every argv, so these
 * tests see what the shell actually did rather than what the script text says.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HELPER = path.resolve(import.meta.dirname, '../updater/rabbitmq-password.sh');
const REAL_CHMOD = spawnSync('sh', ['-c', 'command -v chmod'], { encoding: 'utf-8' }).stdout.trim();
const IS_ROOT = process.getuid?.() === 0;

const STUB_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/argv.log"
case "$1" in
  inspect)
    case "$3" in
      *Config.Env*) [ -n "\${STUB_HUB_PASSWORD:-}" ] && printf 'PATH=/usr/bin\\nRABBITMQ_PASSWORD=%s\\n' "$STUB_HUB_PASSWORD"; exit 0 ;;
      *State.Running*) [ "$4" = ci-hub-queue ] && echo true && exit 0; exit 1 ;;
    esac ;;
  exec)
    if [ "$2" = -i ]; then
      given="$(cat)"
      case "$5" in
        authenticate_user) [ "$given" = "$(cat "$STUB_DIR/broker")" ] && exit 0; exit 65 ;;
        change_password) printf '%s' "$given" > "$STUB_DIR/broker"; exit 0 ;;
      esac
    fi
    [ "$3" = rabbitmq-diagnostics ] && [ -e "$STUB_DIR/broker-down" ] && exit 1
    exit 0 ;;
  restart) exit 0 ;;
esac
exit 0
`;

const SCRIPT = [
  'set -o errexit -o nounset -o pipefail',
  `. ${JSON.stringify(HELPER)}`,
  'rabbitmq_password_prepare "$1" ci-hub',
  'echo "WRITTEN=$RABBITMQ_PASSWORD_WRITTEN"',
  'rabbitmq_password_check_broker "$1" ci-hub 4',
].join('\n');

let dir: string;
let envFile: string;

/** The runner's own environment, minus the two variables the helper reads, so a CI value cannot leak in. */
function baseEnv(env: Record<string, string>, extraPath: string): NodeJS.ProcessEnv {
  const { RABBITMQ_PASSWORD: _password, CI_HUB_CONTAINER_UID: _uid, ...rest } = process.env;
  return { ...rest, ...env, STUB_DIR: dir, PATH: `${extraPath}${path.join(dir, 'bin')}:${process.env.PATH}` };
}

function run(env: Record<string, string> = {}, extraPath = '') {
  return spawnSync('bash', ['-c', SCRIPT, 'bash', envFile], { encoding: 'utf-8', env: baseEnv(env, extraPath) });
}

/** A folder of stubs that go on PATH ahead of the docker stub. */
function stubBin(stubs: Record<string, string>): string {
  const bin = path.join(dir, `stubs-${Object.keys(stubs).join('-')}`);
  mkdirSync(bin);
  for (const [name, body] of Object.entries(stubs)) writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}:`;
}

const passwordLines = () =>
  readFileSync(envFile, 'utf-8')
    .split('\n')
    .filter((line) => line.startsWith('RABBITMQ_PASSWORD='));
const argvLog = () => (existsSync(path.join(dir, 'argv.log')) ? readFileSync(path.join(dir, 'argv.log'), 'utf-8') : '');
const broker = () => readFileSync(path.join(dir, 'broker'), 'utf-8');
const mode = () => statSync(envFile).mode & 0o777;
const leftovers = () => readdirSync(dir).filter((name) => name.startsWith('hub.env.'));

/**
 * A group the runner is in that a new file in `dir` does not get: Linux gives a new file the creator's
 * primary group, BSD and macOS the folder's. A file moved into that group only stays there if the
 * helper chowns its rewrite back. Undefined when the runner has no such group.
 */
function foreignGroup(): number | undefined {
  const probe = path.join(dir, 'probe');
  writeFileSync(probe, '');
  const newFileGid = statSync(probe).gid;
  rmSync(probe);
  const groups = spawnSync('id', ['-G'], { encoding: 'utf-8' }).stdout.trim().split(/\s+/).map(Number);
  return groups.find((gid) => Number.isInteger(gid) && gid !== newFileGid && spawnSync('chgrp', [String(gid), dir]).status === 0);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'updater-rabbitmq-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), STUB_DOCKER, { mode: 0o755 });
  writeFileSync(path.join(dir, 'broker'), 'admin');
  envFile = path.join(dir, 'hub.env');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rabbitmq_password_prepare and rabbitmq_password_check_broker', () => {
  it.each([
    ['no RABBITMQ_PASSWORD', 'JWT_SECRET=jwt\nDOMAIN=example.com\n'],
    ['RABBITMQ_PASSWORD=admin', 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\nDOMAIN=example.com\n'],
    ['two RABBITMQ_PASSWORD lines', 'RABBITMQ_PASSWORD=admin\nJWT_SECRET=jwt\nRABBITMQ_PASSWORD=\nDOMAIN=example.com'],
  ])('from an env file with %s, writes one random password, and moves the broker onto it', (_case, body) => {
    writeFileSync(envFile, body, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    const owner = statSync(envFile).uid;

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('WRITTEN=yes');
    expect(result.stdout).toContain('wrote a new random password');
    const lines = passwordLines();
    expect(lines).toHaveLength(1);
    const password = lines[0]?.slice('RABBITMQ_PASSWORD='.length) ?? '';
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    const content = readFileSync(envFile, 'utf-8');
    expect(content).toContain('JWT_SECRET=jwt\n');
    expect(content).toContain('DOMAIN=example.com\n');
    expect(mode()).toBe(0o600);
    expect(statSync(envFile).uid).toBe(owner);
    expect(leftovers()).toEqual([]);
    // The broker still had admin, so the check changed it and restarted the Hub onto it.
    expect(broker()).toBe(password);
    expect(argvLog()).toMatch(/^exec -i ci-hub-queue rabbitmqctl authenticate_user companion$/m);
    expect(argvLog()).toMatch(/^exec -i ci-hub-queue rabbitmqctl change_password companion$/m);
    expect(argvLog()).toMatch(/^restart ci-hub$/m);
    expect(argvLog()).not.toContain(password);
  });

  it("uses the running Hub's own strong password, which the broker already accepts, and says so", () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });
    writeFileSync(path.join(dir, 'broker'), 'hub-running-password');

    const result = run({ STUB_HUB_PASSWORD: 'hub-running-password' });

    expect(result.status, result.stderr).toBe(0);
    expect(passwordLines()).toEqual(['RABBITMQ_PASSWORD=hub-running-password']);
    expect(result.stdout).toContain('wrote the password the running Hub uses');
    expect(result.stdout).not.toContain('random');
    expect(argvLog()).not.toContain('change_password');
    expect(argvLog()).not.toMatch(/^restart/m);
    expect(argvLog()).not.toContain('hub-running-password');
  });

  it('never takes admin from a running Hub', () => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\n', { mode: 0o600 });

    expect(run({ STUB_HUB_PASSWORD: 'admin' }).status).toBe(0);

    expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
  });

  // Compose prefers an exported value over the env file, and so does sync-rabbitmq-password.ts.
  it('writes an exported RABBITMQ_PASSWORD, and checks the broker against it', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });

    const result = run({ RABBITMQ_PASSWORD: 'exported-strong', STUB_HUB_PASSWORD: 'hub-running-password' });

    expect(result.status, result.stderr).toBe(0);
    expect(passwordLines()).toEqual(['RABBITMQ_PASSWORD=exported-strong']);
    expect(result.stdout).toContain('wrote the exported RABBITMQ_PASSWORD');
    expect(broker()).toBe('exported-strong');
  });

  it('moves the broker onto an exported password, not the different one in the env file', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=file-strong\n', { mode: 0o600 });

    expect(run({ RABBITMQ_PASSWORD: 'exported-strong' }).status).toBe(0);

    expect(passwordLines()).toEqual(['RABBITMQ_PASSWORD=file-strong']);
    expect(broker()).toBe('exported-strong');
  });

  it.each([
    ['0644', 0o644, 0o600],
    ['0640', 0o640, 0o600],
    ['0400', 0o400, 0o400],
  ])('clears group and other bits only: mode %s', (_name, before, after) => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\n');
    chmodSync(envFile, before);

    expect(run().status).toBe(0);

    expect(mode()).toBe(after);
  });

  // The Hub then reads the file as that uid, through the group or other bits (docker-entrypoint.sh).
  it.each([
    ['exported', { CI_HUB_CONTAINER_UID: '4242' }, 'JWT_SECRET=jwt\n'],
    ['in the env file', {}, 'JWT_SECRET=jwt\nCI_HUB_CONTAINER_UID=4242\n'],
  ])('keeps a 0644 file at 0644 when CI_HUB_CONTAINER_UID (%s) pins the Hub to a uid other than the owner', (_where, env, body) => {
    writeFileSync(envFile, body);
    chmodSync(envFile, 0o644);

    const result = run(env);

    expect(result.status, result.stderr).toBe(0);
    expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
    expect(mode()).toBe(0o644);
  });

  it.each([
    ['0, exported', { CI_HUB_CONTAINER_UID: '0' }, 'CI_HUB_CONTAINER_UID=4242\n'],
    ["the file's owner, in the env file", {}, `CI_HUB_CONTAINER_UID=${process.getuid?.() ?? 0}\n`],
  ])('still clears the bits when CI_HUB_CONTAINER_UID is %s', (_case, env, body) => {
    writeFileSync(envFile, body);
    chmodSync(envFile, 0o644);

    expect(run(env).status).toBe(0);
    expect(mode()).toBe(0o600);
  });

  it('keeps the owner and group of a file whose group a new file would not get', (context) => {
    const gid = foreignGroup();
    if (gid === undefined) return context.skip();
    writeFileSync(envFile, 'JWT_SECRET=jwt\n', { mode: 0o600 });
    // foreignGroup moved dir into that group so it is known to be allowed; put dir back.
    spawnSync('chgrp', [String(statSync(path.dirname(dir)).gid), dir]);
    expect(spawnSync('chgrp', [String(gid), envFile]).status).toBe(0);
    const before = statSync(envFile);

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
    expect(statSync(envFile).uid).toBe(before.uid);
    expect(statSync(envFile).gid).toBe(before.gid);
  });

  it('stops with one line naming the fix, and changes nothing, when it cannot give the rewrite its owner', (context) => {
    const gid = foreignGroup();
    if (gid === undefined) return context.skip();
    spawnSync('chgrp', [String(statSync(path.dirname(dir)).gid), dir]);
    const body = 'JWT_SECRET=jwt\n';
    writeFileSync(envFile, body, { mode: 0o600 });
    expect(spawnSync('chgrp', [String(gid), envFile]).status).toBe(0);

    const result = run({}, stubBin({ chown: 'exit 1' }));

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Run update.sh as root (sudo), or as the user who owns');
    expect(readFileSync(envFile, 'utf-8')).toBe(body);
    expect(leftovers()).toEqual([]);
  });

  it('leaves a strong password byte for byte, and still checks the broker on every run', () => {
    const body = 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=already-strong\n';
    writeFileSync(envFile, body, { mode: 0o600 });
    // An earlier run wrote the file and stopped before the broker took the password.
    writeFileSync(path.join(dir, 'broker'), 'admin');

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('WRITTEN=\n');
    expect(readFileSync(envFile, 'utf-8')).toBe(body);
    expect(broker()).toBe('already-strong');
  });

  it('removes the temp file and leaves the env file alone when the rename fails', () => {
    const body = 'JWT_SECRET=jwt\n';
    writeFileSync(envFile, body, { mode: 0o600 });

    const result = run({}, stubBin({ mv: 'echo invoked >> "$STUB_DIR/mv.log"; exit 1' }));

    expect(result.status).not.toBe(0);
    // The run failed at the rename, not somewhere before it.
    expect(readFileSync(path.join(dir, 'mv.log'), 'utf-8')).toBe('invoked\n');
    expect(readFileSync(envFile, 'utf-8')).toBe(body);
    expect(leftovers()).toEqual([]);
  });

  it('removes the temp file when TERM arrives part way through the rewrite', async () => {
    const body = 'JWT_SECRET=jwt\n';
    writeFileSync(envFile, body, { mode: 0o600 });
    // chmod runs right after mktemp: block there, with the temp file on disk, until TERM arrives.
    const blocking = stubBin({ chmod: `touch "$STUB_DIR/blocked"; sleep 1; exec ${REAL_CHMOD} "$@"` });
    const child = spawn('bash', ['-c', SCRIPT, 'bash', envFile], { env: baseEnv({}, blocking), stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

    for (let waited = 0; !existsSync(path.join(dir, 'blocked')) && waited < 10_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(leftovers()).toHaveLength(1);
    child.kill('SIGTERM');

    expect(await exited).toBe(143);
    expect(leftovers()).toEqual([]);
    expect(readFileSync(envFile, 'utf-8')).toBe(body);
  });

  it.skipIf(IS_ROOT)('stops, and leaves the file as it was, when the env file cannot be read', () => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\n', { mode: 0o600 });
    chmodSync(envFile, 0o000);

    const result = run();
    chmodSync(envFile, 0o600);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('could not read');
    expect(readFileSync(envFile, 'utf-8')).toBe('JWT_SECRET=jwt\n');
    expect(leftovers()).toEqual([]);
  });

  it('refuses a symlinked env file instead of replacing the link with a copy', () => {
    const target = path.join(dir, 'real.env');
    writeFileSync(target, 'JWT_SECRET=jwt\n', { mode: 0o600 });
    symlinkSync(target, envFile);

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('is a symlink');
    expect(lstatSync(envFile).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('JWT_SECRET=jwt\n');
  });

  it('says the broker is not ready when it does not come up, rather than that changing it failed', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });
    writeFileSync(path.join(dir, 'broker-down'), '');

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('broker not ready');
    expect(result.stdout).not.toContain('changing it failed');
    expect(argvLog()).not.toContain('rabbitmqctl');
  });

  it('stops the update when there is no env file and no exported password', () => {
    const result = run({ RABBITMQ_PASSWORD: '' });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('does not exist');
    expect(existsSync(envFile)).toBe(false);
  });
});

describe('update.sh', () => {
  const updater = readFileSync(path.resolve(import.meta.dirname, '../updater/update.sh'), 'utf-8');
  const at = (marker: string) => {
    const index = updater.indexOf(marker);
    expect(index, `marker not found in update.sh: ${marker}`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('sources the helper, backs up the env file, prepares the password before the first compose call, and checks the broker after up', () => {
    expect(at('/rabbitmq-password.sh"')).toBeLessThan(at('rabbitmq_password_prepare "$ENV_FILE_PATH"'));
    expect(at('cp "$ENV_FILE_PATH" "$BACKUP_DIR/dot-env.backup"')).toBeLessThan(at('rabbitmq_password_prepare "$ENV_FILE_PATH"'));
    expect(at('rabbitmq_password_prepare "$ENV_FILE_PATH"')).toBeLessThan(at('docker compose "${COMPOSE_ARGS[@]}" pull'));
    expect(at('rabbitmq_password_check_broker "$ENV_FILE_PATH"')).toBeGreaterThan(at('up -d --remove-orphans'));
  });
});
