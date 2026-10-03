/**
 * The legacy wipe scripts must remove the marketplace apps a Hub installed before they delete the
 * Hub state those apps mount.
 *
 * On core-2 (2026-09-17) scripts/nuke.sh deleted .internal and the Hub containers only. ci-memory,
 * OpenClaw, Hermes, and import-tools kept running against bind sources that no longer existed, and
 * their Hub MCP calls to the fresh Hub returned 401.
 *
 * The real scripts run from a copy of the checkout layout in a temp directory, with `docker`, `id`,
 * and `sudo` replaced on PATH. The fake docker records, for every call, whether the state directory
 * still existed at that moment, so the ordering is observed rather than inferred from the source.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '..');

const FAKE_DOCKER = `#!/bin/bash
internal=no; [ -d "$FAKE_ROOT/.internal" ] && internal=yes
appdata=no; [ -d "$FAKE_ROOT/app-data" ] && appdata=yes
echo "$* | internal=$internal app-data=$appdata" >> "$FAKE_DOCKER_LOG"
if [ "$FAKE_DOCKER_DOWN" = "1" ]; then
  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
  exit 1
fi
case "$*" in
  'ps -a --filter label=ci-hub.managed=true --format {{.Label "com.docker.compose.project"}}')
    # The Hub's own services carry the managed label too; they must not be treated as apps.
    printf 'ci-hub\\nci-memory_ci-marketplace\\nci-memory_ci-marketplace\\n' ;;
  'ps -a --filter label=ci-os-hub.managed=true --format {{.Label "com.docker.compose.project"}}')
    # core-2's apps were created before the rename and carry only the legacy label.
    printf 'ci-openclaw_ci-marketplace\\n\\n' ;;
  'ps -aq --filter label=com.docker.compose.project=ci-memory_ci-marketplace') printf 'aaa\\nbbb\\n' ;;
  'ps -aq --filter label=com.docker.compose.project=ci-openclaw_ci-marketplace') printf 'ccc\\n' ;;
  'ps -aq --filter label=com.docker.compose.project=ci-hub') printf 'hub1\\ncloudflared1\\n' ;;
  'network ls -q --filter label=com.docker.compose.project=ci-memory_ci-marketplace') printf 'net1\\n' ;;
  'volume ls -q --filter label=com.docker.compose.project=ci-memory_ci-marketplace') printf 'vol1\\n' ;;
esac
exit 0
`;

function writeExecutable(file: string, content: string) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

describe('legacy wipe scripts remove Hub-managed apps before the state they mount', () => {
  let root: string;
  let bin: string;
  let dockerLog: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nuke-managed-apps-'));
    bin = path.join(root, 'bin');
    dockerLog = path.join(root, 'docker.log');
    mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    mkdirSync(bin);
    for (const script of ['nuke.sh', 'unsafe-cleanup.sh', path.join('lib', 'managed-app-teardown.sh')]) {
      copyFileSync(path.join(SCRIPTS_DIR, script), path.join(root, 'scripts', script));
    }
    writeExecutable(path.join(bin, 'docker'), FAKE_DOCKER);
    writeExecutable(path.join(bin, 'id'), '#!/bin/sh\necho "${FAKE_UID:-0}"\n');
    writeExecutable(path.join(bin, 'sudo'), '#!/bin/sh\necho "sudo $*" >> "$FAKE_DOCKER_LOG"\n');
    mkdirSync(path.join(root, '.internal', 'app-data', 'ci-marketplace', 'ci-memory'), { recursive: true });
    mkdirSync(path.join(root, 'app-data'), { recursive: true });
    writeFileSync(dockerLog, '');
    // These scripts prune and remove real Docker state. Refuse to run them unless the scripts will
    // resolve every command they wipe with to the fakes.
    for (const tool of ['docker', 'id', 'sudo']) {
      const resolved = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: scriptEnv() }).stdout.trim();
      if (resolved !== path.join(bin, tool)) {
        throw new Error(`${tool} resolves to ${resolved || 'nothing'}, not the fake in ${bin}; not running destructive scripts`);
      }
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const scriptEnv = (options: { uid?: string; dockerDown?: boolean } = {}) => ({
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_ROOT: root,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_UID: options.uid ?? '0',
    FAKE_DOCKER_DOWN: options.dockerDown ? '1' : '0',
  });
  const runScript = (script: string, args: string[] = [], options: { uid?: string; input?: string; dockerDown?: boolean } = {}) =>
    spawnSync('bash', [path.join(root, 'scripts', script), ...args], {
      encoding: 'utf8',
      input: options.input,
      env: scriptEnv(options),
    });
  const dockerCalls = () => readFileSync(dockerLog, 'utf8').split('\n').filter(Boolean);
  const indexOfCall = (prefix: string) => dockerCalls().findIndex((line) => line.startsWith(prefix));

  it('nuke.sh removes every managed app, under either label, while .internal still exists', () => {
    const result = runScript('nuke.sh');

    expect(result.status).toBe(0);
    const calls = dockerCalls();
    expect(calls).toContain('rm -f aaa bbb | internal=yes app-data=yes');
    expect(calls).toContain('rm -f ccc | internal=yes app-data=yes');
    expect(calls).toContain('network rm net1 | internal=yes app-data=yes');
    expect(calls).toContain('volume rm vol1 | internal=yes app-data=yes');
    expect(result.stdout).toContain('ci-memory_ci-marketplace');
    expect(result.stdout).toContain('ci-openclaw_ci-marketplace');
    // The data directory is deleted, and only after the apps are gone.
    expect(existsSync(path.join(root, '.internal'))).toBe(false);
  });

  it('nuke.sh takes the still-running Hub off each app network before removing it', () => {
    // The Hub joins every app's own network (backend HubAppNetworkService), and Docker refuses to
    // remove a network with an endpoint on it; the Hub stack is only stopped after the apps.
    runScript('nuke.sh');

    expect(indexOfCall('network disconnect --force net1 ci-hub |')).toBeGreaterThan(-1);
    expect(indexOfCall('network disconnect --force net1 ci-os-hub |')).toBeGreaterThan(-1);
    expect(indexOfCall('network disconnect --force net1 ci-hub |')).toBeLessThan(indexOfCall('network rm net1'));
    expect(indexOfCall('network rm net1')).toBeLessThan(indexOfCall('rm -f ci-hub '));
  });

  it('nuke.sh does not treat the Hub stack as an app, but still removes its sidecars by project', () => {
    runScript('nuke.sh');

    const calls = dockerCalls();
    // Removed once, by the Hub stack teardown, not by the app loop (which would also list its networks and volumes).
    expect(calls.filter((line) => line.startsWith('ps -aq --filter label=com.docker.compose.project=ci-hub |'))).toHaveLength(1);
    expect(calls.some((line) => line.startsWith('network ls -q --filter label=com.docker.compose.project=ci-hub '))).toBe(false);
    expect(calls).toContain('rm -f hub1 cloudflared1 | internal=yes app-data=yes');
    expect(indexOfCall('rm -f aaa bbb')).toBeLessThan(indexOfCall('volume rm ci_hub_pgdata'));
  });

  it('nuke.sh --keep-apps leaves the apps and says what they still depend on', () => {
    const result = runScript('nuke.sh', ['--keep-apps']);

    expect(result.status).toBe(0);
    expect(dockerCalls().some((line) => line.startsWith('rm -f aaa') || line.startsWith('rm -f ccc'))).toBe(false);
    expect(result.stderr).toContain('ci-memory_ci-marketplace');
    expect(result.stderr).toContain('ci-openclaw_ci-marketplace');
    expect(result.stderr).toMatch(/bind mounts into the Hub data directory/);
    expect(result.stderr).toMatch(/401/);
  });

  it('nuke.sh refuses to run without root and deletes nothing (it used to exit 0 here)', () => {
    const result = runScript('nuke.sh', [], { uid: '1000' });

    expect(result.status).toBe(1);
    expect(dockerCalls()).toEqual([]);
    expect(existsSync(path.join(root, '.internal'))).toBe(true);
  });

  it('nuke.sh deletes nothing when Docker cannot list containers, because the apps would restart with the daemon', () => {
    const result = runScript('nuke.sh', [], { dockerDown: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot list Hub-managed apps/);
    expect(existsSync(path.join(root, '.internal'))).toBe(true);
    expect(dockerCalls().some((line) => line.startsWith('rm ') || line.startsWith('volume rm'))).toBe(false);
  });

  it('nuke.sh --keep-apps still wipes when Docker cannot list containers, with a warning', () => {
    const result = runScript('nuke.sh', ['--keep-apps'], { dockerDown: true });

    expect(result.stderr).toMatch(/could not list Hub-managed apps/);
    expect(existsSync(path.join(root, '.internal'))).toBe(false);
  });

  it('nuke.sh stops before deleting anything when its teardown helper is missing', () => {
    rmSync(path.join(root, 'scripts', 'lib', 'managed-app-teardown.sh'));

    const result = runScript('nuke.sh');

    expect(result.status).toBe(1);
    expect(dockerCalls()).toEqual([]);
    expect(existsSync(path.join(root, '.internal'))).toBe(true);
  });

  it('unsafe-cleanup.sh prunes and deletes nothing when Docker cannot list containers', () => {
    const result = runScript('unsafe-cleanup.sh', [], { input: 'y\n', dockerDown: true });

    expect(result.status).toBe(1);
    expect(dockerCalls().some((line) => line.startsWith('system prune'))).toBe(false);
    expect(existsSync(path.join(root, 'app-data'))).toBe(true);
  });

  it('nuke.sh rejects an unknown option before touching anything', () => {
    const result = runScript('nuke.sh', ['--keep-app']);

    expect(result.status).toBe(2);
    expect(dockerCalls()).toEqual([]);
  });

  it('unsafe-cleanup.sh removes running apps before pruning and deleting app-data (prune skips running containers)', () => {
    const result = runScript('unsafe-cleanup.sh', [], { input: 'y\n' });

    expect(result.status).toBe(0);
    const calls = dockerCalls();
    expect(calls).toContain('rm -f aaa bbb | internal=yes app-data=yes');
    expect(calls).toContain('rm -f ccc | internal=yes app-data=yes');
    expect(indexOfCall('rm -f aaa bbb')).toBeLessThan(indexOfCall('system prune'));
    // The script used to call scripts/stop.sh, which no longer exists.
    expect(result.stderr).not.toMatch(/stop\.sh/);
  });
});
