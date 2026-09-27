/**
 * `cihub reset` prints "Reset complete" only when nothing it set out to remove is left.
 *
 * During the 2026-09-26 fleet rebuild, reset hit EACCES on the data dir on 15 of 17 nodes (core-2,
 * core-3, and fzzy among them): containers had written folders under `app-data/` as root. It
 * printed the error in a yellow box, then "Hub runtime state, volumes, and host data were removed",
 * and exited 0. The data dir, with `.env`, `.env.dev`, and up to 7.7 GB of app state, survived, and
 * the operators found out only when the next install picked it up.
 *
 * The EACCES here is real: a folder under the data dir loses its write permission, as a root-owned
 * one is for the login user. So these tests skip when run as root and on Windows. Docker is a fake
 * that records its calls; its `docker run` either deletes the data dir as a rootful daemon's root
 * container would, or does nothing, as rootless Docker's does for files owned by root.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  home: '',
  dataDir: '',
  locked: '',
  appliance: true,
  calls: [] as string[],
  rootContainerDeletes: false,
  rootContainerStarts: true,
  lingeringVolumes: [] as string[],
}));

vi.mock('../lib/cli-proc.js', () => ({
  run: vi.fn((_cmd: string, args: string[]) => state.calls.push(args.join(' '))),
  runBestEffort: vi.fn((_cmd: string, args: string[]) => {
    state.calls.push(args.join(' '));
    if (args[0] !== 'run') return true;
    if (!state.rootContainerStarts) return false;
    if (state.rootContainerDeletes) {
      // The folder bind-mounted at /d, emptied as root would.
      const mount = args[args.indexOf('-v') + 1];
      const hostPath = mount.slice(0, mount.lastIndexOf(':/d'));
      chmodSync(state.locked, 0o755);
      rmSync(hostPath, { recursive: true, force: true });
      mkdirSync(hostPath);
    }
    return true;
  }),
  runCapture: vi.fn((_cmd: string, args: string[]) => {
    state.calls.push(args.join(' '));
    if (args.join(' ') === 'volume ls --format {{.Name}}') {
      return { ok: true, stdout: state.lingeringVolumes.join('\n') };
    }
    return { ok: true, stdout: '' };
  }),
}));
vi.mock('../lib/cli-prompt.js', () => ({ confirmDestructiveAction: vi.fn(async () => true) }));
vi.mock('../lib/cli-repo-context.js', () => ({ isApplianceMode: () => state.appliance, requireRepoRoot: vi.fn() }));
vi.mock('../lib/cli-lifecycle.js', () => ({ startHub: vi.fn() }));
vi.mock('../lib/cli-ui.js', () => ({ dim: (text: string) => text, printMessageBox: vi.fn() }));
vi.mock('../lib/cli-compose-env.js', () => ({
  getEnvFileOrExit: () => path.join(state.home, 'repo', '.env.dev'),
  buildEnvOverrides: () => ({}),
}));
vi.mock('../lib/hub-context.js', () => ({
  requireRepoOrApplianceContext: vi.fn(),
  resolveHubContext: () => ({
    env: 'prod',
    appliance: state.appliance,
    envFile: path.join(state.dataDir, '.env'),
    composeFiles: [path.join(state.dataDir, 'docker-compose.prod.yml')],
    cwd: state.dataDir,
    dataDir: state.dataDir,
  }),
  composeArgsForContext: () => ['compose', '--project-name', 'ci-hub'],
  envOverridesForContext: () => ({}),
}));

import { startHub } from '../lib/cli-lifecycle.js';
import { cleanHub, recreateHub, resetHub } from '../lib/cli-teardown';
import { printMessageBox } from '../lib/cli-ui.js';

const boxes = () => vi.mocked(printMessageBox).mock.calls.map(([title, lines]) => ({ title, lines }));
const box = (title: string) => boxes().find((entry) => entry.title === title);
const rootContainerRuns = () => state.calls.filter((line) => line.startsWith('run --rm -v '));
const lockedFolders: string[] = [];
const lock = (folder: string) => {
  chmodSync(folder, 0o555);
  lockedFolders.push(folder);
};

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('cihub reset reports host data it could not delete', () => {
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();

  beforeEach(() => {
    state.home = mkdtempSync(path.join(tmpdir(), 'cli-reset-host-data-'));
    process.env.HOME = state.home;
    state.appliance = true;
    state.dataDir = path.join(state.home, '.local', 'share', 'companion-hub');
    state.locked = path.join(state.dataDir, 'app-data', 'ci-marketplace', 'opencode', 'data', 'opencode', 'share', 'log');
    state.calls = [];
    state.rootContainerDeletes = false;
    state.rootContainerStarts = true;
    state.lingeringVolumes = [];
    vi.clearAllMocks();
    mkdirSync(state.locked, { recursive: true });
    writeFileSync(path.join(state.locked, 'opencode.log'), 'x');
    writeFileSync(path.join(state.dataDir, '.env'), 'X=1\n');
    writeFileSync(path.join(state.dataDir, 'docker-compose.prod.yml'), 'services: {}\n');
    lock(state.locked);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    process.env.HOME = previousHome;
    process.exitCode = undefined;
    for (const folder of lockedFolders.splice(0)) {
      if (existsSync(folder)) chmodSync(folder, 0o755);
    }
    rmSync(state.home, { recursive: true, force: true });
  });

  it('does not print "Reset complete", names the folder and the cause, gives the sudo command, and exits 1', async () => {
    await expect(resetHub('prod', true)).resolves.toBe(false);

    expect(existsSync(state.locked)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(box('Reset complete')).toBeUndefined();
    const leftBehind = box('Host data left behind');
    expect(leftBehind?.lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${state.dataDir} is still there: 1 entry`),
        expect.stringMatching(new RegExp(`^  EACCES ${escapeRegExp(state.locked)}: 1 entry in it cannot be deleted`)),
        `Delete it as root: sudo rm -rf -- '${state.dataDir}'`,
      ]),
    );
    const incomplete = box('Reset incomplete');
    expect(incomplete?.lines).toEqual(
      expect.arrayContaining(['Installed apps, Hub containers, and Hub volumes were removed.', `  sudo rm -rf -- '${state.dataDir}'`]),
    );
    // Everything the login user could delete went, including the env file with the Hub's secrets.
    expect(existsSync(path.join(state.dataDir, '.env'))).toBe(false);
  });

  it('retries through the root container on an appliance install, and succeeds when that removes it', async () => {
    state.rootContainerDeletes = true;

    await expect(resetHub('prod', true)).resolves.toBe(true);

    expect(rootContainerRuns()).toEqual([`run --rm -v ${state.dataDir}:/d alpine sh -c rm -rf /d/* /d/.[!.]* /d/..?* 2>/dev/null || true`]);
    expect(existsSync(state.dataDir)).toBe(false);
    expect(box('Reset complete')).toBeDefined();
    expect(process.exitCode).toBeUndefined();
  });

  it('says the root container did not start when Docker could not run it', async () => {
    state.rootContainerStarts = false;

    await expect(resetHub('prod', true)).resolves.toBe(false);

    expect(box('Host data left behind')?.lines).toEqual(expect.arrayContaining([expect.stringContaining('did not start')]));
  });

  it('does not print "Reset complete" when a Hub volume survived its removal', async () => {
    state.rootContainerDeletes = true;
    state.lingeringVolumes = ['ci_hub_pgdata'];

    await expect(resetHub('prod', true)).resolves.toBe(false);

    expect(box('Reset complete')).toBeUndefined();
    expect(box('Reset incomplete')?.lines).toEqual(
      expect.arrayContaining(['Volumes still there: ci_hub_pgdata', '  docker volume rm ci_hub_pgdata']),
    );
    expect(process.exitCode).toBe(1);
  });

  it('cihub recreate does not start a Hub on the surviving data', async () => {
    await recreateHub('prod', true, true);

    expect(startHub).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('--dry-run names the folder that will need the root container, and deletes nothing', async () => {
    await expect(resetHub('prod', false, true)).resolves.toBe(false);

    expect(existsSync(path.join(state.dataDir, '.env'))).toBe(true);
    expect(rootContainerRuns()).toEqual([]);
    const dryRun = box('Dry run: nothing was removed');
    expect(dryRun?.lines).toEqual(
      expect.arrayContaining([
        `  ${state.dataDir}`,
        expect.stringMatching(new RegExp(`^      EACCES ${escapeRegExp(state.locked)}: 1 entry in it cannot be deleted`)),
        expect.stringContaining('reset exits 1'),
      ]),
    );
  });

  it('cihub clean reports the survivor and exits 1 instead of throwing EACCES', () => {
    expect(() => cleanHub('prod')).not.toThrow();

    expect(box('Host data left behind')).toBeDefined();
    expect(box('Prod Hub data wiped')).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it('in a checkout, still deletes the tunnel dir when the root folder cannot be deleted', async () => {
    // The root folder threw on its delete, and the tunnel dir, with the Cloudflare token, was never tried.
    state.appliance = false;
    const repo = path.join(state.home, 'repo');
    const rootFolder = path.join(repo, 'hub-data');
    const tunnel = path.join(repo, 'tunnel');
    state.locked = path.join(rootFolder, 'app-data', 'log');
    mkdirSync(state.locked, { recursive: true });
    writeFileSync(path.join(state.locked, 'x.log'), 'x');
    lock(state.locked);
    mkdirSync(tunnel);
    writeFileSync(path.join(tunnel, 'token'), 'secret');
    writeFileSync(path.join(repo, '.env.dev'), `ROOT_FOLDER_HOST=${rootFolder}\n`);
    process.chdir(repo);

    await expect(resetHub('dev', true)).resolves.toBe(false);

    expect(existsSync(tunnel)).toBe(false);
    expect(existsSync(state.locked)).toBe(true);
    expect(box('Environment files partly cleaned')?.lines).toEqual([`left behind root folder: ${rootFolder}`, `tunnel dir: ${tunnel}`]);
    expect(box('Reset complete')).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
