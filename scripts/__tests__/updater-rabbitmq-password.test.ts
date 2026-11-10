/**
 * scripts/updater/rabbitmq-password.sh, run for real against a stub `docker` on PATH (Companion-Hub#884).
 *
 * update.sh sources it to give the env file a broker password other than `admin` before compose reads
 * it, and to check the broker accepts that password after `up`. The stub keeps the broker's password in
 * a file, reads rabbitmqctl's password from stdin as the real one does, and logs every argv, so these
 * tests see what the shell actually did rather than what the script text says.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HELPER = path.resolve(import.meta.dirname, '../updater/rabbitmq-password.sh');

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
    exit 0 ;;
  restart) exit 0 ;;
esac
exit 0
`;

let dir: string;
let envFile: string;

function run(env: Record<string, string> = {}, extraPath = '') {
  const script = [
    'set -o errexit -o nounset -o pipefail',
    `. ${JSON.stringify(HELPER)}`,
    'rabbitmq_password_prepare "$1" ci-hub',
    'echo "WRITTEN=$RABBITMQ_PASSWORD_WRITTEN"',
    'rabbitmq_password_check_broker "$1" ci-hub 4',
  ].join('\n');
  return spawnSync('bash', ['-c', script, 'bash', envFile], {
    encoding: 'utf-8',
    env: { ...process.env, ...env, STUB_DIR: dir, PATH: `${extraPath}${path.join(dir, 'bin')}:${process.env.PATH}` },
  });
}

const passwordLines = () =>
  readFileSync(envFile, 'utf-8')
    .split('\n')
    .filter((line) => line.startsWith('RABBITMQ_PASSWORD='));
const argvLog = () => (existsSync(path.join(dir, 'argv.log')) ? readFileSync(path.join(dir, 'argv.log'), 'utf-8') : '');
const broker = () => readFileSync(path.join(dir, 'broker'), 'utf-8');
const mode = () => statSync(envFile).mode & 0o777;
const leftovers = () => readdirSync(dir).filter((name) => name.startsWith('hub.env.'));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'updater-rabbitmq-'));
  const bin = path.join(dir, 'bin');
  spawnSync('mkdir', [bin]);
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

  it("uses the running Hub's own strong password, which the broker already accepts", () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });
    writeFileSync(path.join(dir, 'broker'), 'hub-running-password');

    const result = run({ STUB_HUB_PASSWORD: 'hub-running-password' });

    expect(result.status, result.stderr).toBe(0);
    expect(passwordLines()).toEqual(['RABBITMQ_PASSWORD=hub-running-password']);
    expect(argvLog()).not.toContain('change_password');
    expect(argvLog()).not.toMatch(/^restart/m);
    expect(argvLog()).not.toContain('hub-running-password');
  });

  it('never takes admin from a running Hub', () => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\n', { mode: 0o600 });

    expect(run({ STUB_HUB_PASSWORD: 'admin' }).status).toBe(0);

    expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
  });

  it('tightens a looser mode to 0600 instead of copying it', () => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\n');
    chmodSync(envFile, 0o644);

    expect(run().status).toBe(0);

    expect(mode()).toBe(0o600);
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
    const failingBin = path.join(dir, 'failing-bin');
    spawnSync('mkdir', [failingBin]);
    writeFileSync(path.join(failingBin, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const result = run({}, `${failingBin}:`);

    expect(result.status).not.toBe(0);
    expect(readFileSync(envFile, 'utf-8')).toBe(body);
    expect(leftovers()).toEqual([]);
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

  it('sources the helper, prepares the password before the first compose call, and checks the broker after up', () => {
    expect(at('/rabbitmq-password.sh"')).toBeLessThan(at('rabbitmq_password_prepare "$ENV_FILE_PATH"'));
    expect(at('rabbitmq_password_prepare "$ENV_FILE_PATH"')).toBeLessThan(at('docker compose "${COMPOSE_ARGS[@]}" pull'));
    expect(at('rabbitmq_password_check_broker "$ENV_FILE_PATH"')).toBeGreaterThan(at('up -d --remove-orphans'));
  });
});
