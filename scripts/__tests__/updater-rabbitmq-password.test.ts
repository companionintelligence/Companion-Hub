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
const REAL_GREP = spawnSync('sh', ['-c', 'command -v grep'], { encoding: 'utf-8' }).stdout.trim();
const IS_ROOT = process.getuid?.() === 0;

/**
 * Missing-container output is Docker CLI 29.9.3's (measured 2026-11-09): an untyped `docker inspect
 * NAME` prints "[]" on stdout (without -f) and "error: no such object: NAME" on stderr; a typed
 * `docker container inspect NAME` prints "Error response from daemon: No such container: NAME" on
 * stderr. Both exit 1. STUB_OLD_DOCKER gives the older untyped form, "Error: No such object: NAME",
 * and STUB_LOWER_TYPED a lowercase typed one, "error response from daemon: no such container: NAME".
 * STUB_DOCKER_ERROR (stderr text, exit 1, empty stdout) answers every inspect whose argv matches the
 * glob STUB_DOCKER_ERROR_ON, as a daemon that is down would.
 *
 * The stub's Hub container is STUB_HUB, `ci-hub` by default (absent with STUB_NO_HUB), and its broker
 * STUB_QUEUE, `ci-hub-queue` by default. When the folder $STUB_DIR/hubs exists it lists the Hub
 * containers instead, running or stopped alike (docker inspect sees both): one file per container,
 * named after it and holding its environment. Its environment starts as
 * STUB_HUB_PASSWORD and STUB_HUB_UID, and `compose-up-sim` stands in for update.sh's `up`: it gives the
 * Hub the password compose would (STUB_UP_PASSWORD when a test needs compose's exact parsing, else an
 * exported RABBITMQ_PASSWORD, else the env file's plain line).
 */
const STUB_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/argv.log"
hub_env() {
  if [ -f "$STUB_DIR/hub-env" ]; then cat "$STUB_DIR/hub-env"; return; fi
  [ -n "\${STUB_HUB_PASSWORD:-}" ] && printf 'RABBITMQ_PASSWORD=%s\\n' "$STUB_HUB_PASSWORD"
  [ -n "\${STUB_HUB_UID:-}" ] && printf 'CI_HUB_CONTAINER_UID=%s\\n' "$STUB_HUB_UID"
  printf 'PATH=/usr/bin\\n'
}
case "$1" in
  compose-up-sim)
    [ -n "\${STUB_NO_HUB:-}\${STUB_NO_UP:-}" ] && exit 0
    [ -d "$STUB_DIR/hubs" ] && exit 0
    pw="\${STUB_UP_PASSWORD:-\${RABBITMQ_PASSWORD:-$(grep '^RABBITMQ_PASSWORD=' "$2" | tail -n 1 | cut -d= -f2-)}}"
    { printf 'RABBITMQ_PASSWORD=%s\\n' "$pw"; [ -n "\${STUB_HUB_UID:-}" ] && printf 'CI_HUB_CONTAINER_UID=%s\\n' "$STUB_HUB_UID"; } > "$STUB_DIR/hub-env.new"
    mv "$STUB_DIR/hub-env.new" "$STUB_DIR/hub-env"
    exit 0 ;;
  inspect | container)
    typed=""
    if [ "$1" = container ]; then typed=1; shift; fi
    if [ -n "\${STUB_DOCKER_ERROR:-}" ]; then
      # shellcheck disable=SC2254
      case "$*" in $STUB_DOCKER_ERROR_ON) printf '%s\\n' "$STUB_DOCKER_ERROR" >&2; exit 1 ;; esac
    fi
    hub="\${STUB_HUB:-ci-hub}"
    queue="\${STUB_QUEUE:-ci-hub-queue}"
    if [ -d "$STUB_DIR/hubs" ]; then
      name="\${4:-$2}"
      [ "$2" = -f ] || name="$2"
      if [ -f "$STUB_DIR/hubs/$name" ]; then
        [ "$2" != -f ] && exit 0
        case "$3" in
          *Config.Env*) cat "$STUB_DIR/hubs/$name"; exit 0 ;;
          *Config.User*) echo; exit 0 ;;
        esac
      fi
      hub="(none)"
    fi
    absent() {
      [ "$2" = untyped-no-format ] && echo '[]'
      if [ -n "$typed" ] && [ -n "\${STUB_LOWER_TYPED:-}" ]; then echo "error response from daemon: no such container: $1" >&2
      elif [ -n "$typed" ]; then echo "Error response from daemon: No such container: $1" >&2
      elif [ -n "\${STUB_OLD_DOCKER:-}" ]; then echo "Error: No such object: $1" >&2
      else echo "error: no such object: $1" >&2; fi
      exit 1
    }
    if [ "$2" != -f ]; then
      [ "$2" = "$hub" ] && [ -z "\${STUB_NO_HUB:-}" ] && exit 0
      [ "$2" = "$queue" ] && exit 0
      absent "$2" untyped-no-format
    fi
    case "$3" in
      *Config.Env*) [ "$4" = "$hub" ] && [ -z "\${STUB_NO_HUB:-}" ] && hub_env && exit 0; absent "$4" ;;
      *Config.User*) [ "$4" = "$hub" ] && [ -z "\${STUB_NO_HUB:-}" ] && printf '%s\\n' "\${STUB_HUB_USER:-}" && exit 0; absent "$4" ;;
      *State.Running*) [ "$4" = "$queue" ] && echo true && exit 0; absent "$4" ;;
      *Health*) [ "$4" = "$queue" ] || absent "$4"; if [ -e "$STUB_DIR/broker-down" ]; then echo starting; else echo healthy; fi; exit 0 ;;
    esac ;;
  exec)
    if [ "$2" = -i ]; then
      given="$(cat)"
      case "$5" in
        authenticate_user) [ "$given" = "$(cat "$STUB_DIR/broker")" ] && exit 0; exit 65 ;;
        change_password) [ -z "\${STUB_CHANGE_NOOP:-}" ] && printf '%s' "$given" > "$STUB_DIR/broker"; exit 0 ;;
      esac
    fi
    exit 0 ;;
  restart) exit 0 ;;
esac
exit 0
`;

/**
 * Stands in for `timeout` on PATH, so the wrapper's timeouts are deterministic and never hang, on any
 * machine. It logs every command it runs. A command matching the glob STUB_HANG exits 124 without
 * running, as a real timeout would, after STUB_HANG_SKIP earlier matches have run normally.
 */
const STUB_TIMEOUT = `#!/usr/bin/env bash
shift
printf '%s\\n' "$*" >> "$STUB_DIR/timeout.log"
if [ -n "\${STUB_HANG:-}" ]; then
  # shellcheck disable=SC2254
  case "$*" in
    $STUB_HANG)
      seen=$(cat "$STUB_DIR/hang-count" 2>/dev/null || echo 0)
      echo $((seen + 1)) > "$STUB_DIR/hang-count"
      [ "$seen" -ge "\${STUB_HANG_SKIP:-0}" ] && exit 124 ;;
  esac
fi
exec "$@"
`;

const SCRIPT = [
  'set -o errexit -o nounset -o pipefail',
  `. ${JSON.stringify(HELPER)}`,
  'rabbitmq_password_prepare "$1" ci-hub',
  'echo "WRITTEN=$RABBITMQ_PASSWORD_WRITTEN"',
  'docker compose-up-sim "$1"',
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
const restarts = () => argvLog().match(/^restart ci-hub$/gm)?.length ?? 0;

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
  writeFileSync(path.join(bin, 'timeout'), STUB_TIMEOUT, { mode: 0o755 });
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
    ['admin and an inline comment', 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin # shipped default\nDOMAIN=example.com\n'],
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
    // The broker already matched, but the rename gave the env file a new inode: one restart.
    expect(restarts()).toBe(1);
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

  it('refuses to rewrite a symlinked env file, and names the file to fix', () => {
    const target = path.join(dir, 'real.env');
    writeFileSync(target, 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\n', { mode: 0o600 });
    symlinkSync(target, envFile);

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('is a symlink');
    expect(result.stdout).toContain('in the file the link points to');
    expect(result.stdout).not.toContain('ENV_FILE');
    expect(lstatSync(envFile).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\n');
  });

  it('lets a symlinked env file that already has a strong password through untouched', () => {
    const target = path.join(dir, 'real.env');
    writeFileSync(target, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });
    symlinkSync(target, envFile);
    writeFileSync(path.join(dir, 'broker'), 'already-strong');

    const result = run();

    expect(result.status, result.stdout).toBe(0);
    expect(lstatSync(envFile).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('RABBITMQ_PASSWORD=already-strong\n');
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

  // Compose drops an inline comment, so the Hub gets `strongpw`. The check must use that, not the raw line.
  it.each([
    ['an inline comment', 'RABBITMQ_PASSWORD=strongpw # set by ops\n'],
    ['a quoted value and a trailing comment', 'RABBITMQ_PASSWORD="strongpw" # q\n'],
  ])('with %s, checks the broker against the value the Hub got, and changes nothing', (_case, body) => {
    writeFileSync(envFile, body, { mode: 0o600 });
    writeFileSync(path.join(dir, 'broker'), 'strongpw');

    const result = run({ STUB_UP_PASSWORD: 'strongpw' });

    expect(result.status, result.stdout).toBe(0);
    expect(readFileSync(envFile, 'utf-8')).toBe(body);
    expect(broker()).toBe('strongpw');
    expect(argvLog()).not.toContain('change_password');
    expect(restarts()).toBe(0);
  });

  it.each([
    ['an inline comment', 'RABBITMQ_PASSWORD=strongpw # set by ops\n'],
    ['a quoted value and a trailing comment', 'RABBITMQ_PASSWORD="strongpw" # q\n'],
  ])('with %s, moves a stale broker onto exactly the value the Hub holds', (_case, body) => {
    writeFileSync(envFile, body, { mode: 0o600 });

    const result = run({ STUB_UP_PASSWORD: 'strongpw' });

    expect(result.status, result.stdout).toBe(0);
    expect(broker()).toBe('strongpw');
    expect(restarts()).toBe(1);
  });

  it('never changes the broker when there is no Hub container to take the password from', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

    const result = run({ STUB_NO_HUB: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('no Hub container');
    expect(broker()).toBe('admin');
    expect(argvLog()).not.toContain('change_password');
  });

  it('restarts the Hub only when this run rewrote the env file', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });
    writeFileSync(path.join(dir, 'broker'), 'already-strong');

    expect(run().status).toBe(0);
    expect(restarts()).toBe(0);

    writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });
    writeFileSync(path.join(dir, 'hub-env'), 'RABBITMQ_PASSWORD=already-strong\n');
    expect(run().status).toBe(0);
    expect(passwordLines()).toEqual(['RABBITMQ_PASSWORD=already-strong']);
    expect(restarts()).toBe(1);
  });

  // Compose reads all three forms as a pin (measured with `docker compose config`).
  it.each([
    ['indented', '  CI_HUB_CONTAINER_UID=4242\n'],
    ['spaced around =', 'CI_HUB_CONTAINER_UID = 4242\n'],
    ['exported', 'export CI_HUB_CONTAINER_UID=4242\n'],
    ['quoted with a comment', 'CI_HUB_CONTAINER_UID="4242" # pinned\n'],
  ])('reads a %s CI_HUB_CONTAINER_UID in the env file as a pin, and keeps 0644', (_form, line) => {
    writeFileSync(envFile, `JWT_SECRET=jwt\n${line}`);
    chmodSync(envFile, 0o644);

    const result = run({ STUB_NO_HUB: '1', RABBITMQ_PASSWORD: '' });

    expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
    expect(mode()).toBe(0o644);
    expect(result.stdout).not.toContain('mode changed');
  });

  it.each([
    ['CI_HUB_CONTAINER_UID', { STUB_HUB_UID: '4242' }],
    ['Config.User', { STUB_HUB_USER: '4242:4242' }],
  ])("takes the pin from the running Hub's %s when the env file has none", (_source, env) => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\n');
    chmodSync(envFile, 0o644);

    expect(run(env).status).toBe(0);

    expect(mode()).toBe(0o644);
  });

  it('says when it narrows the env file mode', () => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\n');
    chmodSync(envFile, 0o644);

    const result = run();

    expect(result.stdout).toContain('mode changed from 644 to 600');
  });

  it('replaces every form compose reads as RABBITMQ_PASSWORD, leaving one line', () => {
    writeFileSync(envFile, 'export RABBITMQ_PASSWORD=admin\n  RABBITMQ_PASSWORD = admin\nJWT_SECRET=jwt\n', { mode: 0o600 });

    expect(run().status).toBe(0);

    const content = readFileSync(envFile, 'utf-8');
    expect(content.match(/RABBITMQ_PASSWORD/g)).toHaveLength(1);
    expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
  });

  it('stops, and leaves the file byte for byte, when the rewrite cannot read the env file', () => {
    const body = 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\n';
    writeFileSync(envFile, body, { mode: 0o600 });
    // Exit 2 (a read error) for the rewrite's `grep -vE` only; every other grep is the real one.
    const failingGrep = stubBin({ grep: `if [ "$1" = -vE ]; then exit 2; fi\nexec ${REAL_GREP} "$@"` });

    const result = run({}, failingGrep);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('could not read');
    expect(readFileSync(envFile, 'utf-8')).toBe(body);
    expect(leftovers()).toEqual([]);
  });

  // These need the quotes stripped: left on, `"admin"` reads as a strong password and is kept.
  it.each([
    ['double-quoted', 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD="admin"\n'],
    ['single-quoted with a comment', "JWT_SECRET=jwt\nRABBITMQ_PASSWORD='admin' # c\n"],
    ['double-quoted with a comment after the closing quote', 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD="admin" # x\n'],
  ])('reads a %s admin as admin, and rewrites it to one random password', (_case, body) => {
    writeFileSync(envFile, body, { mode: 0o600 });

    const result = run();

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('WRITTEN=yes');
    expect(passwordLines()).toHaveLength(1);
    expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
    expect(readFileSync(envFile, 'utf-8')).not.toContain('admin');
  });

  // The quoted value is the owner's own uid, so it is no foreign pin and the bits are cleared.
  it("reads a quoted CI_HUB_CONTAINER_UID of the file's owner as no pin, and narrows 0644 to 0600", () => {
    const uid = process.getuid?.() ?? Number(spawnSync('id', ['-u'], { encoding: 'utf-8' }).stdout.trim());
    writeFileSync(envFile, `JWT_SECRET=jwt\nCI_HUB_CONTAINER_UID="${uid}" # c\n`);
    chmodSync(envFile, 0o644);

    const result = run({ STUB_NO_HUB: '1' });

    expect(passwordLines()[0], result.stdout).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
    expect(mode()).toBe(0o600);
  });

  it('reads a CRLF env file without the carriage return, and writes a clean line', () => {
    writeFileSync(envFile, 'JWT_SECRET=jwt\r\nRABBITMQ_PASSWORD=admin\r\nDOMAIN=example.com\r\n', { mode: 0o600 });

    const result = run();

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('WRITTEN=yes');
    const content = readFileSync(envFile, 'utf-8');
    expect(content).not.toContain('admin');
    expect(content).toMatch(/\nRABBITMQ_PASSWORD=[0-9a-f]{64}\n$/);
    expect(content).toContain('JWT_SECRET=jwt\r\n');
  });

  it('restarts the Hub exactly once when it both rewrote the env file and changed the broker', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });

    const result = run();

    expect(result.status, result.stdout).toBe(0);
    expect(argvLog()).toContain('change_password');
    expect(result.stdout).toContain('WRITTEN=yes');
    expect(restarts()).toBe(1);
  });

  it('asks the broker again after change_password, and reports a change that did not take', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

    const result = run({ STUB_CHANGE_NOOP: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('changing it failed');
    expect(argvLog().match(/rabbitmqctl authenticate_user/g)).toHaveLength(2);
    expect(restarts()).toBe(0);
  });

  it('with no Hub container, checks the broker against an exported password before the env file', () => {
    writeFileSync(envFile, 'RABBITMQ_PASSWORD=file-strong\n', { mode: 0o600 });
    writeFileSync(path.join(dir, 'broker'), 'exported-strong');

    const result = run({ STUB_NO_HUB: '1', RABBITMQ_PASSWORD: 'exported-strong' });

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('accepts the broker password');
    expect(argvLog()).not.toContain('change_password');
  });

  describe("reads docker's own words for a missing container, from stderr only", () => {
    const output = (result: ReturnType<typeof run>) => `${result.stdout}${result.stderr}`;
    const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
    const DIAL_ERROR =
      'failed to connect to the docker API at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: no such file or directory';

    it.each([
      ['Docker 29', {}],
      ['older Docker', { STUB_OLD_DOCKER: '1' }],
      ['a lowercase typed answer', { STUB_LOWER_TYPED: '1' }],
    ])('with no Hub container (%s), carries on and says so, with no ERROR', (_docker, env) => {
      writeFileSync(envFile, 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\n', { mode: 0o600 });
      // The prepare step only: with no Hub there is no password to move the broker onto.
      const prepareOnly = `set -o errexit -o nounset -o pipefail\n. ${JSON.stringify(HELPER)}\nrabbitmq_password_prepare "$1" ci-hub\necho CONTINUED`;

      const result = spawnSync('bash', ['-c', prepareOnly, 'bash', envFile], { encoding: 'utf-8', env: baseEnv({ STUB_NO_HUB: '1', ...env }, '') });

      expect(output(result)).toContain('NOTE: no Hub container (ci-hub, ci-os-hub) exists');
      expect(output(result)).not.toContain('ERROR');
      expect(output(result)).not.toContain('could not check');
      // No Hub password to reuse and none exported, so the file gets a password of its own.
      expect(result.status, output(result)).toBe(0);
      expect(result.stdout).toContain('CONTINUED');
      expect(result.stdout).toContain('wrote a new random password');
      expect(passwordLines()).toHaveLength(1);
      expect(passwordLines()[0]).toMatch(/^RABBITMQ_PASSWORD=[0-9a-f]{64}$/);
    });

    it('finds the broker of a ci-os-hub layout, where ci-hub-queue does not exist', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=os-strong\n', { mode: 0o600 });
      writeFileSync(path.join(dir, 'broker'), 'os-strong');

      const result = run({ STUB_HUB: 'ci-os-hub', STUB_QUEUE: 'ci-os-hub-queue', STUB_HUB_PASSWORD: 'os-strong', STUB_NO_UP: '1' });

      expect(result.status, output(result)).toBe(0);
      expect(result.stdout).toContain('OK: ci-os-hub-queue accepts the broker password the Hub uses');
      expect(output(result)).not.toContain('ERROR');
    });

    it.each([
      ['the daemon is down', DAEMON_DOWN],
      ['the socket dial fails with "no such file or directory"', DIAL_ERROR],
    ])('stops on the Hub probe when %s, naming the cause, and changes nothing', (_case, message) => {
      const body = 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\n';
      writeFileSync(envFile, body, { mode: 0o600 });

      const result = run({ STUB_DOCKER_ERROR: message, STUB_DOCKER_ERROR_ON: 'inspect ci-hub' });

      expect(result.status).toBe(1);
      expect(output(result)).toContain(`ERROR: could not check for the Hub container ci-hub (docker exited 1: ${message})`);
      expect(readFileSync(envFile, 'utf-8')).toBe(body);
      expect(broker()).toBe('admin');
      expect(argvLog()).not.toContain('rabbitmqctl');
    });

    it.each([
      ['the daemon is down', DAEMON_DOWN],
      ['the socket dial fails with "no such file or directory"', DIAL_ERROR],
    ])('stops on the broker probe when %s, naming the cause, and changes nothing', (_case, message) => {
      const body = 'RABBITMQ_PASSWORD=already-strong\n';
      writeFileSync(envFile, body, { mode: 0o600 });

      const result = run({ STUB_DOCKER_ERROR: message, STUB_DOCKER_ERROR_ON: 'inspect -f {{.State.Running}} ci-hub-queue' });

      expect(result.status).toBe(1);
      expect(output(result)).toContain(
        `ERROR: the broker could not be checked: docker container inspect ci-hub-queue failed (docker exited 1: ${message})`,
      );
      expect(output(result)).not.toContain('no running broker container');
      expect(readFileSync(envFile, 'utf-8')).toBe(body);
      expect(broker()).toBe('admin');
      expect(argvLog()).not.toContain('rabbitmqctl');
    });
  });

  describe('Hub probe order: the name update.sh passes, then ci-hub, then ci-os-hub', () => {
    /** Hub containers by name, each with the broker password compose gave it. */
    function hubs(passwords: Record<string, string>) {
      mkdirSync(path.join(dir, 'hubs'));
      for (const [name, password] of Object.entries(passwords)) {
        writeFileSync(path.join(dir, 'hubs', name), `RABBITMQ_PASSWORD=${password}\nPATH=/usr/bin\n`);
      }
    }
    const checkBroker = (hubArg: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          `set -o errexit -o nounset -o pipefail\n. ${JSON.stringify(HELPER)}\nrabbitmq_password_check_broker "$1" "$2" 4`,
          'bash',
          envFile,
          hubArg,
        ],
        { encoding: 'utf-8', env: baseEnv({}, '') },
      );
    const restartsOf = (name: string) => argvLog().match(new RegExp(`^restart ${name}$`, 'gm'))?.length ?? 0;

    beforeEach(() => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=os-password\n', { mode: 0o600 });
    });

    it('picks the running ci-os-hub it is given over a stopped ci-hub that holds another password', () => {
      hubs({ 'ci-os-hub': 'os-password', 'ci-hub': 'stale-password' });

      const result = checkBroker('ci-os-hub');

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(broker()).toBe('os-password');
      expect(result.stdout).toContain('to the one ci-os-hub uses; restarting ci-os-hub');
      expect(restartsOf('ci-os-hub')).toBe(1);
      expect(restartsOf('ci-hub')).toBe(0);
    });

    it('picks ci-hub when it is given ci-hub and both exist', () => {
      hubs({ 'ci-os-hub': 'os-password', 'ci-hub': 'hub-password' });

      const result = checkBroker('ci-hub');

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(broker()).toBe('hub-password');
      expect(restartsOf('ci-hub')).toBe(1);
      expect(restartsOf('ci-os-hub')).toBe(0);
    });

    it('with no name given, tries ci-hub first', () => {
      hubs({ 'ci-os-hub': 'os-password', 'ci-hub': 'hub-password' });

      const result = checkBroker('');

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(broker()).toBe('hub-password');
      expect(restartsOf('ci-hub')).toBe(1);
    });

    it('with no name given and no ci-hub, falls through to ci-os-hub', () => {
      hubs({ 'ci-os-hub': 'os-password' });

      const result = checkBroker('');

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(broker()).toBe('os-password');
      expect(restartsOf('ci-os-hub')).toBe(1);
      expect(argvLog()).toMatch(/^container inspect ci-hub$/m);
    });

    it('names each Hub container once when none exists, whichever name it is given', () => {
      mkdirSync(path.join(dir, 'hubs'));
      const run = (hubArg: string) =>
        spawnSync('bash', ['-c', `. ${JSON.stringify(HELPER)}\nrabbitmq_password_hub_container "$1"`, 'bash', hubArg], {
          encoding: 'utf-8',
          env: baseEnv({}, ''),
        }).stderr;

      expect(run('ci-os-hub')).toContain('no Hub container (ci-os-hub, ci-hub) exists');
      expect(run('ci-hub')).toContain('no Hub container (ci-hub, ci-os-hub) exists');
      expect(run('')).toContain('no Hub container (ci-hub, ci-os-hub) exists');
    });
  });

  describe('rabbitmq_password_docker_says_absent', () => {
    const saysAbsent = (stderr: string) =>
      spawnSync('bash', ['-c', `. ${JSON.stringify(HELPER)}\nrabbitmq_password_docker_says_absent "$1"`, 'bash', stderr]).status === 0;

    it.each([
      'error: no such object: X',
      'Error response from daemon: No such container: X',
      'Error: No such object: X',
      'error response from daemon: no such container: X',
    ])('reads %j as absent', (stderr) => {
      expect(saysAbsent(stderr)).toBe(true);
    });

    it.each([
      'dial unix /var/run/docker.sock: connect: no such file or directory',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    ])('reads %j as could-not-check, not absent', (stderr) => {
      expect(saysAbsent(stderr)).toBe(false);
    });
  });

  describe('a docker call that times out is a visible failure, never a wrong answer', () => {
    const output = (result: ReturnType<typeof run>) => `${result.stdout}${result.stderr}`;

    it('stops when the Hub probe times out, and changes neither the broker nor the env file', () => {
      const body = 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\n';
      writeFileSync(envFile, body, { mode: 0o600 });

      const result = run({ STUB_HANG: 'docker container inspect ci-hub' });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('ERROR: could not check for the Hub container ci-hub (timed out');
      expect(readFileSync(envFile, 'utf-8')).toBe(body);
      expect(broker()).toBe('admin');
      expect(argvLog()).not.toContain('rabbitmqctl');
    });

    it('stops when the Hub probe times out in the broker check, instead of falling back to the env file', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

      // The first probe (prepare) is skipped: the file is strong. The broker check's probe hangs.
      const result = run({ STUB_HANG: 'docker container inspect ci-hub' });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('could not check for the Hub container ci-hub');
      expect(argvLog()).not.toContain('rabbitmqctl');
    });

    it("stops when reading the Hub's environment times out", () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

      const result = run({ STUB_HANG: 'docker container inspect -f {{range .Config.Env}}* ci-hub' });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("ERROR: could not read the Hub's broker password from ci-hub");
      expect(argvLog()).not.toContain('rabbitmqctl');
    });

    it('warns when the Hub has no RABBITMQ_PASSWORD in its environment', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });
      writeFileSync(path.join(dir, 'hub-env'), 'PATH=/usr/bin\n');
      // Skip the stand-in `up`, which would give the Hub the file's password.
      const script = SCRIPT.replace('docker compose-up-sim "$1"', ':');

      const result = spawnSync('bash', ['-c', `${script}\necho CONTINUED`, 'bash', envFile], { encoding: 'utf-8', env: baseEnv({}, '') });

      expect(output(result)).toContain('WARNING: the Hub container ci-hub has no RABBITMQ_PASSWORD');
      expect(result.status, output(result)).toBe(0);
      expect(result.stdout).toContain('CONTINUED');
      expect(output(result)).not.toContain('ERROR');
    });

    it('stops when the broker probe times out, rather than saying there is no broker', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

      const result = run({ STUB_HANG: 'docker container inspect -f {{.State.Running}} ci-hub-queue' });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('ERROR: the broker could not be checked');
      expect(output(result)).not.toContain('no running broker container');
    });

    it.each([
      ['CI_HUB_CONTAINER_UID', 'docker container inspect -f {{range .Config.Env}}* ci-hub'],
      ['Config.User', 'docker container inspect -f {{.Config.User}} ci-hub'],
    ])('fails the rewrite, and keeps the file and its mode, when the pin probe (%s) times out', (_probe, hang) => {
      const body = 'JWT_SECRET=jwt\nRABBITMQ_PASSWORD=admin\n';
      writeFileSync(envFile, body);
      chmodSync(envFile, 0o644);
      // The exported password means prepare reads no Hub environment before the pin probe.
      const result = run({ STUB_HANG: hang, RABBITMQ_PASSWORD: 'exported-strong' });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('could not tell whether the Hub is pinned');
      expect(readFileSync(envFile, 'utf-8')).toBe(body);
      expect(mode()).toBe(0o644);
      expect(leftovers()).toEqual([]);
    });

    it('reports a restart that times out, after the OK line', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });

      const result = run({ STUB_HANG: 'docker restart ci-hub' });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('restarting ci-hub');
      expect(result.stderr).toContain('ERROR: docker restart ci-hub failed or timed out');
    });

    it('reports a restart that times out on the rewrite-only path too', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });
      writeFileSync(path.join(dir, 'hub-env'), 'RABBITMQ_PASSWORD=already-strong\n');
      writeFileSync(path.join(dir, 'broker'), 'already-strong');

      const result = run({ STUB_HANG: 'docker restart ci-hub' });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('so it reads the rewritten');
      expect(result.stderr).toContain('ERROR: docker restart ci-hub failed or timed out');
    });

    it('warns that a change could not be confirmed when the check after change_password times out', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

      const result = run({ STUB_HANG: 'docker exec -i ci-hub-queue rabbitmqctl authenticate_user companion', STUB_HANG_SKIP: '1' });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('WARNING: changed the broker password');
      expect(result.stdout).toContain('could not be confirmed');
      expect(result.stdout).not.toContain('changing it failed');
      expect(restarts()).toBe(0);
    });

    it('reports a timed-out change_password as unconfirmed, not as a failed change', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

      const result = run({ STUB_HANG: 'docker exec -i ci-hub-queue rabbitmqctl change_password companion' });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('WARNING: rabbitmqctl change_password in ci-hub-queue timed out');
      expect(result.stdout).not.toContain('changing it failed');
      expect(restarts()).toBe(0);
    });

    it('stops when the first authenticate_user times out, without trying to change the password', () => {
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=already-strong\n', { mode: 0o600 });

      const result = run({ STUB_HANG: 'docker exec -i ci-hub-queue rabbitmqctl authenticate_user companion' });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('ERROR: the broker could not be checked: rabbitmqctl authenticate_user in ci-hub-queue timed out');
      expect(argvLog()).not.toContain('change_password');
    });

    it('sends every docker call the helper makes through the timeout wrapper', () => {
      // A path through every docker call: Hub probe, its password, the pin probes, the broker probe
      // and health, authenticate, change, re-check, restart.
      writeFileSync(envFile, 'RABBITMQ_PASSWORD=admin\n', { mode: 0o600 });

      const result = run({ STUB_HUB_PASSWORD: 'admin' });

      expect(result.status, result.stdout).toBe(0);
      const helperDockerCalls = argvLog()
        .split('\n')
        .filter((line) => line && !line.startsWith('compose-up-sim'));
      const wrapped = readFileSync(path.join(dir, 'timeout.log'), 'utf-8')
        .split('\n')
        .filter((line) => line.startsWith('docker '));
      expect(helperDockerCalls.length).toBeGreaterThanOrEqual(10);
      // Every inspect is typed: an untyped one answers a missing container differently (see the stub).
      const inspects = helperDockerCalls.filter((line) => / inspect /.test(` ${line} `));
      expect(inspects.some((line) => line.includes('.State.Health'))).toBe(true);
      for (const line of inspects) expect(line).toMatch(/^container inspect /);
      expect(wrapped.map((line) => line.slice('docker '.length))).toEqual(helperDockerCalls);
    });
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
