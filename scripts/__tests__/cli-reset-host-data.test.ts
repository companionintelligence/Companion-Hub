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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/**
 * The tunnel folder sits beside an appliance's data dir: compose mounts `${ROOT_FOLDER_HOST}/../tunnel`
 * and an appliance's ROOT_FOLDER_HOST is the data dir. Reset deleted only the data dir, so the
 * Cloudflare token and `registration.json` survived it, and the next `cihub up` started cloudflared
 * on the old tunnel. On core-2, `~/.local/share/tunnel/certs` from 2026-08-10 outlived every reset
 * since. `tunnel` is a generic name, so only the Hub's files go, by `cihub uninstall`'s rules.
 */
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  "appliance reset and clean delete the Hub's files in the tunnel folder",
  () => {
    const previousHome = process.env.HOME;
    let share: string;
    let tunnel: string;
    const uid = process.getuid?.();

    /** A tunnel folder the way a paired Hub leaves it: a cloudflared token, `registration.json`, and an empty `certs/`. */
    const writeTunnel = (folder: string, extra: { token?: string; files?: string[]; certs?: string[] } = {}) => {
      mkdirSync(path.join(folder, 'certs'), { recursive: true });
      writeFileSync(path.join(folder, 'token'), extra.token ?? CLOUDFLARED_TOKEN);
      writeFileSync(path.join(folder, 'registration.json'), '{"tunnelId":"6ff42ae2","writtenAt":"2026-09-26T16:47:00.000Z"}\n');
      for (const name of extra.files ?? []) writeFileSync(path.join(folder, name), 'not the Hub');
      for (const name of extra.certs ?? []) writeFileSync(path.join(folder, 'certs', name), 'PEM');
    };
    const list = (folder: string) => readdirSync(folder).sort();

    beforeEach(() => {
      state.home = mkdtempSync(path.join(tmpdir(), 'cli-reset-tunnel-'));
      process.env.HOME = state.home;
      state.appliance = true;
      share = path.join(state.home, '.local', 'share');
      state.dataDir = path.join(share, 'companion-hub');
      tunnel = path.join(share, 'tunnel');
      state.calls = [];
      state.rootContainerDeletes = false;
      state.rootContainerStarts = true;
      state.lingeringVolumes = [];
      vi.clearAllMocks();
      mkdirSync(path.join(state.dataDir, 'state'), { recursive: true });
      writeFileSync(path.join(state.dataDir, '.env'), 'X=1\n');
      writeFileSync(path.join(state.dataDir, 'docker-compose.prod.yml'), 'services: {}\n');
      mkdirSync(path.join(share, 'other-app'));
      writeFileSync(path.join(share, 'other-app', 'data'), 'keep');
    });

    afterEach(() => {
      process.env.HOME = previousHome;
      process.exitCode = undefined;
      for (const folder of lockedFolders.splice(0)) {
        if (existsSync(folder)) chmodSync(folder, 0o755);
      }
      rmSync(state.home, { recursive: true, force: true });
    });

    it('deletes the token, registration.json, and the empty certs/, then the folder, and says "Reset complete"', async () => {
      writeTunnel(tunnel);

      await expect(resetHub('prod', true)).resolves.toBe(true);

      expect(existsSync(tunnel)).toBe(false);
      expect(existsSync(state.dataDir)).toBe(false);
      expect(list(path.join(share, 'other-app'))).toEqual(['data']);
      expect(box('Prod Hub data wiped')?.lines).toEqual([`removed: ${state.dataDir}`, `removed: ${tunnel} (token, registration.json, certs)`]);
      expect(box('Reset complete')).toBeDefined();
      expect(process.exitCode).toBeUndefined();
    });

    it("keeps what is not the Hub's: a token that is not a cloudflared token, other files, and anything in certs/", async () => {
      writeTunnel(tunnel, { token: 'hello world', files: ['notes.txt'], certs: ['custom-ca.pem'] });

      await expect(resetHub('prod', true)).resolves.toBe(true);

      expect(list(tunnel)).toEqual(['certs', 'notes.txt', 'token']);
      expect(list(path.join(tunnel, 'certs'))).toEqual(['custom-ca.pem']);
      expect(box('Prod Hub data wiped')?.lines).toEqual([
        `removed: ${state.dataDir}`,
        `removed from ${tunnel}: registration.json; kept, not the Hub's: certs/custom-ca.pem, notes.txt, token`,
      ]);
      expect(box('Reset complete')).toBeDefined();
    });

    it('does not print "Reset complete" when the Hub\'s tunnel files cannot be deleted, and names a command for only those', async () => {
      writeTunnel(tunnel);
      lock(tunnel);

      await expect(resetHub('prod', true)).resolves.toBe(false);

      expect(list(tunnel)).toEqual(['certs', 'registration.json', 'token']);
      const finish = `sudo rm -f -- '${tunnel}/token' '${tunnel}/registration.json' && sudo rmdir -- '${tunnel}/certs' '${tunnel}'`;
      expect(box('Host data left behind')?.lines).toEqual([
        `${tunnel} still holds the Hub's token, registration.json, certs; this user (uid ${uid}) cannot delete them.`,
        expect.stringMatching(new RegExp(`^  EACCES ${escapeRegExp(tunnel)}: 3 entries in it cannot be deleted`)),
        `Delete only those as root: ${finish}`,
      ]);
      expect(box('Reset incomplete')?.lines).toEqual(expect.arrayContaining([`  ${finish}`]));
      expect(box('Prod Hub data partly wiped')?.lines).toEqual([`removed: ${state.dataDir}`, `left behind: the Hub's files in ${tunnel}`]);
      // The root container empties a whole folder, and this one can hold another program's files.
      expect(rootContainerRuns()).toEqual([]);
      expect(box('Reset complete')).toBeUndefined();
      expect(process.exitCode).toBe(1);
    });

    it("does not follow a symlinked tunnel folder, and exits 1 while the Hub's files are behind it", async () => {
      const elsewhere = path.join(state.home, 'elsewhere', 'tunnel');
      writeTunnel(elsewhere);
      symlinkSync(elsewhere, tunnel);

      await expect(resetHub('prod', true)).resolves.toBe(false);

      expect(lstatSync(tunnel).isSymbolicLink()).toBe(true);
      expect(list(elsewhere)).toEqual(['certs', 'registration.json', 'token']);
      expect(box('Host data left behind')?.lines).toEqual([
        `${tunnel}: it is a symlink, so it was not followed, and the Hub's files behind it are still there: token, registration.json.`,
        `Delete them, if that folder is this Hub's: sudo rm -f -- '${tunnel}/token' '${tunnel}/registration.json'`,
      ]);
      expect(box('Reset complete')).toBeUndefined();
      expect(process.exitCode).toBe(1);
    });

    it("--dry-run lists the tunnel folder with the Hub's files in it and what it keeps, and deletes nothing", async () => {
      writeTunnel(tunnel, { files: ['notes.txt'] });

      await expect(resetHub('prod', false, true)).resolves.toBe(false);

      expect(list(tunnel)).toEqual(['certs', 'notes.txt', 'registration.json', 'token']);
      expect(box('Dry run: nothing was removed')?.lines).toEqual(
        expect.arrayContaining([
          `  ${state.dataDir}`,
          `  ${tunnel}`,
          "    only the Hub's files: token, registration.json; then certs/ and the folder, once empty",
          "    kept, not the Hub's: notes.txt",
        ]),
      );
    });

    it("cihub clean deletes the Hub's tunnel files too", () => {
      writeTunnel(tunnel);

      const results = cleanHub('prod');

      expect(results.map((result) => [result.target, result.removed])).toEqual([
        [state.dataDir, true],
        [tunnel, true],
      ]);
      expect(existsSync(tunnel)).toBe(false);
      expect(box('Prod Hub data wiped')).toBeDefined();
      expect(process.exitCode).toBeUndefined();
    });
  },
);

/** base64 of {"a": account tag, "t": tunnel id, "s": secret}, the format cloudflared reads. */
const CLOUDFLARED_TOKEN = Buffer.from(
  JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: '6ff42ae2-765d-4adf-8112-31c55c1551ef', s: Buffer.alloc(32, 7).toString('base64') }),
).toString('base64');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
