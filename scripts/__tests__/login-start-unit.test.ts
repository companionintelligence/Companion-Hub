import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeLoginStartOutcome,
  ensureLoginStartUnit,
  LOGIN_START_UNIT,
  loginStartPaths,
  removeLoginStartUnit,
  renderLoginStartScript,
  renderLoginStartService,
} from '../lib/login-start-unit';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'login-start-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeSystemctl(options: { session?: boolean } = {}) {
  const calls: string[][] = [];
  const systemctl = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'show-environment') return options.session ?? true;
    return true;
  };
  return { calls, systemctl };
}

describe('login-start unit file', () => {
  it('runs the script at login, and skips quietly once the script is gone', () => {
    const unit = renderLoginStartService('/home/a/.config/companion-hub/login-start.sh');
    expect(unit).toContain('ExecStart=/bin/sh /home/a/.config/companion-hub/login-start.sh');
    expect(unit).toContain('ConditionPathExists=/home/a/.config/companion-hub/login-start.sh');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('quotes a script path with a space in it', () => {
    expect(renderLoginStartService('/home/a b/login-start.sh')).toContain('ExecStart=/bin/sh "/home/a b/login-start.sh"');
  });

  it('follows XDG_CONFIG_HOME, and ignores a relative one as systemd does', () => {
    expect(loginStartPaths({ XDG_CONFIG_HOME: '/cfg' }, '/home/a').unitFile).toBe(`/cfg/systemd/user/${LOGIN_START_UNIT}`);
    expect(loginStartPaths({ XDG_CONFIG_HOME: 'rel' }, '/home/a').unitFile).toBe(`/home/a/.config/systemd/user/${LOGIN_START_UNIT}`);
  });
});

describe('ensureLoginStartUnit', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('writes the unit and script and enables it the first time', () => {
    const { calls, systemctl } = fakeSystemctl();
    expect(ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl })).toBe('installed');

    const paths = loginStartPaths(env, home);
    expect(readFileSync(paths.unitFile, 'utf8')).toBe(renderLoginStartService(paths.scriptFile));
    expect(readFileSync(paths.scriptFile, 'utf8')).toBe(renderLoginStartScript());
    expect(existsSync(paths.markerFile)).toBe(true);
    expect(calls).toContainEqual(['daemon-reload']);
    expect(calls).toContainEqual(['enable', LOGIN_START_UNIT]);
  });

  it('never enables it again, so a user who disabled it keeps it disabled', () => {
    ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl: fakeSystemctl().systemctl });
    const { calls, systemctl } = fakeSystemctl();
    expect(ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl })).toBe('unchanged');
    expect(calls.some((c) => c[0] === 'enable')).toBe(false);
  });

  it('rewrites a stale script without enabling', () => {
    ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl: fakeSystemctl().systemctl });
    writeFileSync(loginStartPaths(env, home).scriptFile, 'old');
    const { calls, systemctl } = fakeSystemctl();
    expect(ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl })).toBe('refreshed');
    expect(readFileSync(loginStartPaths(env, home).scriptFile, 'utf8')).toBe(renderLoginStartScript());
    expect(calls.some((c) => c[0] === 'enable')).toBe(false);
  });

  it('does not bring back a unit the user deleted', () => {
    ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl: fakeSystemctl().systemctl });
    rmSync(loginStartPaths(env, home).unitFile);
    const { calls, systemctl } = fakeSystemctl();
    expect(ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl })).toBe('left-removed');
    expect(existsSync(loginStartPaths(env, home).unitFile)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('writes nothing without a systemd user manager, or off Linux', () => {
    expect(ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl: fakeSystemctl({ session: false }).systemctl })).toBe(
      'no-user-session',
    );
    expect(ensureLoginStartUnit({ platform: 'darwin', env, homeDir: home, systemctl: fakeSystemctl().systemctl })).toBe('not-linux');
    expect(existsSync(loginStartPaths(env, home).unitFile)).toBe(false);
  });

  it('only speaks up when it installed the unit or could not', () => {
    expect(describeLoginStartOutcome('installed')).toContain(`systemctl --user disable ${LOGIN_START_UNIT}`);
    expect(describeLoginStartOutcome('failed')).toContain('docker start ci-hub');
    for (const quiet of ['refreshed', 'unchanged', 'left-removed', 'not-linux', 'no-user-session'] as const) {
      expect(describeLoginStartOutcome(quiet)).toBeNull();
    }
  });
});

describe('removeLoginStartUnit', () => {
  it('disables and deletes the unit, the script and the marker', () => {
    const env = {} as NodeJS.ProcessEnv;
    ensureLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl: fakeSystemctl().systemctl });
    const { calls, systemctl } = fakeSystemctl();
    expect(removeLoginStartUnit({ platform: 'linux', env, homeDir: home, systemctl })).toBe(true);
    const paths = loginStartPaths(env, home);
    for (const file of [paths.unitFile, paths.scriptFile, paths.markerFile]) expect(existsSync(file)).toBe(false);
    expect(calls).toContainEqual(['disable', LOGIN_START_UNIT]);
  });
});

/**
 * The script itself, run by `sh` against a fake `docker` (and a `sleep` that returns at once).
 * `inspect` answers from one file per container id, so the error text is the real shape Docker
 * reports, quotes and all.
 */
describe('login-start script', () => {
  function mountError(src: string): string {
    return `failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error mounting "${src}" to rootfs at "/data/.env": mount src=${src}, dst=/data/.env, dstFd=/proc/thread-self/fd/14, flags=MS_BIND|MS_REC: not a directory: Are you trying to mount a directory onto a file (or vice-versa)? Check if the specified host path exists and is the expected type`;
  }

  function runScript(containers: Record<string, string>, options: { dockerUp?: boolean } = {}) {
    const bin = path.join(home, 'bin');
    const inspectDir = path.join(home, 'inspect');
    mkdirSync(bin);
    mkdirSync(inspectDir);
    const ids = Object.keys(containers);
    for (const id of ids) writeFileSync(path.join(inspectDir, id), containers[id] as string);
    const startLog = path.join(home, 'started');
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
case "$1" in
  info) ${options.dockerUp === false ? 'exit 1' : 'exit 0'} ;;
  ps) case "$*" in *status=exited*) printf '%s\\n' ${ids.join(' ')} ;; esac ;;
  inspect) cat "${inspectDir}/$4" ;;
  start) echo "$2" >>"${startLog}" ;;
esac
`,
    );
    writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, 'docker'), 0o755);
    chmodSync(path.join(bin, 'sleep'), 0o755);
    const scriptFile = path.join(home, 'login-start.sh');
    writeFileSync(scriptFile, renderLoginStartScript());
    const result = spawnSync('sh', [scriptFile], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    const started = existsSync(startLog) ? readFileSync(startLog, 'utf8').split('\n').filter(Boolean) : [];
    return { status: result.status, stdout: result.stdout, started };
  }

  it('starts the Hub first, then the rest that missed a bind mount at boot', () => {
    const present = path.join(home, 'env');
    writeFileSync(present, '');
    const { status, started, stdout } = runScript({
      aaa: `/traefik|unless-stopped|${mountError(present)}`,
      bbb: `/ci-hub|unless-stopped|${mountError(present)}`,
    });
    expect(status).toBe(0);
    expect(started).toEqual(['ci-hub', 'traefik']);
    expect(stdout).toContain(`started ci-hub, which could not mount ${present} at boot`);
  });

  it('leaves alone what someone stopped, what has no restart policy, and what has no mount error', () => {
    const present = path.join(home, 'env');
    writeFileSync(present, '');
    const { started } = runScript({
      a1: '/ci-hub|unless-stopped|',
      a2: `/one-off|no|${mountError(present)}`,
      a3: '/crashed|always|exec format error',
    });
    expect(started).toEqual([]);
  });

  it('leaves a container stopped while its file is still missing, and says so', () => {
    const missing = path.join(home, 'never-there');
    const { status, started, stdout } = runScript({ c1: `/ci-hub|always|${mountError(missing)}` });
    expect(status).toBe(0);
    expect(started).toEqual([]);
    expect(stdout).toContain(`left ci-hub stopped: ${missing} is still missing`);
  });

  it('exits 0 without starting anything when Docker never answers', () => {
    const { status, started, stdout } = runScript({}, { dockerUp: false });
    expect(status).toBe(0);
    expect(started).toEqual([]);
    expect(stdout).toContain('Docker did not answer');
  });
});
