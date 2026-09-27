/**
 * `cihub reset` prints "Reset complete" only when nothing it set out to remove is left.
 *
 * During the 2026-09-26 fleet rebuild, reset hit EACCES on the data dir on 3 of 17 nodes (core-2,
 * core-3, and fzzy): containers had written folders under `app-data/` as root. It printed the error
 * in a yellow box, then "Hub runtime state, volumes, and host data were removed", and exited 0. The
 * data dir, with `.env`, `.env.dev`, and up to 7.7 GB of app state, survived, and the operators
 * found out only when the next install picked it up. On every appliance the tunnel folder beside the
 * data dir, with the Cloudflare token and `registration.json`, survived too, and nothing said so.
 *
 * The EACCES here is real: a folder under the data dir loses its write permission, as a root-owned
 * one is for the login user. So these tests skip when run as root and on Windows. Docker is a fake
 * that records its calls and the engine each went to, and answers listings from `state.listings`;
 * its `docker run` either empties the bind-mounted folder as a rootful daemon's root container
 * would, or does nothing, as rootless Docker's does for files owned by root.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUB_NETWORK_NAMES } from '../hub-cleanup-lib';

const state = vi.hoisted(() => ({
  home: '',
  dataDir: '',
  locked: '',
  lockedFolders: [] as string[],
  appliance: true,
  calls: [] as string[],
  /** The DOCKER_HOST each docker call carried; `compose` goes through envOverridesForContext, mocked below. */
  dockerHosts: [] as { args: string; dockerHost: string | undefined }[],
  rootContainerDeletes: false,
  rootContainerStarts: true,
  /** Answers by the exact argv, joined with spaces. Anything else lists nothing. */
  listings: {} as Record<string, { ok: boolean; stdout: string }>,
}));

vi.mock('../lib/cli-proc.js', () => {
  const record = (args: string[], env?: Record<string, string | undefined>) => {
    state.calls.push(args.join(' '));
    state.dockerHosts.push({ args: args.join(' '), dockerHost: env?.DOCKER_HOST });
  };
  return {
    run: vi.fn((_cmd: string, args: string[]) => record(args)),
    runBestEffort: vi.fn((_cmd: string, args: string[], env?: Record<string, string | undefined>) => {
      record(args, env);
      if (args[0] !== 'run') return true;
      if (!state.rootContainerStarts) return false;
      if (state.rootContainerDeletes) {
        // Root ignores the modes that stop the login user, inside the folder bind-mounted at /d.
        const mount = args[args.indexOf('-v') + 1];
        const hostPath = mount.slice(0, mount.lastIndexOf(':/d'));
        for (const folder of state.lockedFolders) {
          if ((folder === hostPath || folder.startsWith(`${hostPath}${path.sep}`)) && existsSync(folder)) chmodSync(folder, 0o755);
        }
        for (const name of readdirSync(hostPath)) rmSync(path.join(hostPath, name), { recursive: true, force: true });
      }
      return true;
    }),
    runCapture: vi.fn((_cmd: string, args: string[], env?: Record<string, string | undefined>) => {
      record(args, env);
      return state.listings[args.join(' ')] ?? { ok: true, stdout: '' };
    }),
  };
});
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
const lock = (folder: string) => {
  chmodSync(folder, 0o555);
  state.lockedFolders.push(folder);
};
const listed = (stdout: string) => ({ ok: true, stdout });
/** What `cihub up` checks before it starts `cloudflared` (cli-compose-env.ts), unmocked. */
const upWouldStartTheOldTunnel = async (dataDir: string) =>
  (await vi.importActual<typeof import('../lib/cli-compose-env.js')>('../lib/cli-compose-env.js')).hasRegisteredCloudflareTunnelAtDataDir(dataDir);

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('cihub reset reports host data it could not delete', () => {
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();

  beforeEach(() => {
    state.home = mkdtempSync(path.join(tmpdir(), 'cli-reset-host-data-'));
    process.env.HOME = state.home;
    // Nothing from the machine running the tests may choose the engine, the unit dir, or the root folder.
    vi.stubEnv('DOCKER_HOST', '');
    vi.stubEnv('CI_HUB_DOCKER_HOST', '');
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('ROOT_FOLDER_HOST', '');
    state.appliance = true;
    state.dataDir = path.join(state.home, '.local', 'share', 'companion-hub');
    state.locked = path.join(state.dataDir, 'app-data', 'ci-marketplace', 'opencode', 'data', 'opencode', 'share', 'log');
    state.calls = [];
    state.dockerHosts = [];
    state.rootContainerDeletes = false;
    state.rootContainerStarts = true;
    state.listings = {};
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
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    for (const folder of state.lockedFolders.splice(0)) {
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
    // No GPU probe timer is installed here, so there is nothing to say about the folder coming back.
    expect(box('Reset complete')?.lines).toEqual([
      'Hub runtime state, volumes, and host data were removed.',
      'Re-launch CI Hub or run `cihub up dev` (or `cihub up prod`) to start fresh.',
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('says the root container did not start when Docker could not run it', async () => {
    state.rootContainerStarts = false;

    await expect(resetHub('prod', true)).resolves.toBe(false);

    expect(box('Host data left behind')?.lines).toEqual(expect.arrayContaining([expect.stringContaining('did not start')]));
  });

  it('does not print "Reset complete" when a Hub volume survived its removal', async () => {
    state.rootContainerDeletes = true;
    state.listings = { 'volume ls --format {{.Name}}': listed('ci_hub_pgdata') };

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

  it("sends every docker call to the Hub's pinned engine, including the final check and the root container", async () => {
    // The pin the desktop app and `cihub up` write. It lives in the data dir the reset deletes, so
    // it has to be read before that; the default engine here would be some other daemon.
    state.rootContainerDeletes = true;
    mkdirSync(path.join(state.dataDir, 'state'), { recursive: true });
    writeFileSync(
      path.join(state.dataDir, 'state', 'docker-engine.json'),
      JSON.stringify({ dockerHost: 'unix:///run/hub-engine.sock', kind: 'system', reason: 'test', selectedAt: 0 }),
    );

    await expect(resetHub('prod', true)).resolves.toBe(true);

    // `compose down` takes its engine from envOverridesForContext, which is mocked here.
    const calls = state.dockerHosts.filter((call) => !call.args.startsWith('compose '));
    expect(calls.map((call) => call.args)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^run --rm -v /), 'ps -a --format {{.Names}}', 'volume ls --format {{.Name}}']),
    );
    expect(calls.filter((call) => call.dockerHost !== 'unix:///run/hub-engine.sock')).toEqual([]);
    // Reading the pin did not write it back into the deleted data dir.
    expect(existsSync(state.dataDir)).toBe(false);
  });

  it('does not print "Reset complete" while an app, a stray container on the Hub network, or a Hub container is still listed', async () => {
    state.rootContainerDeletes = true;
    const onHubNetwork = [
      'ps',
      '-a',
      ...HUB_NETWORK_NAMES.flatMap((network) => ['--filter', `network=${network}`]),
      '--format',
      '{{.Names}} {{.Labels}}',
    ];
    state.listings = {
      'ps -a --filter label=ci-hub.managed=true --format {{.Labels}}': listed('com.docker.compose.project=ci-hermes,ci-hub.managed=true'),
      'ps -a --filter label=com.docker.compose.project=ci-hermes --format {{.Names}}': listed('ci-hermes-1'),
      [onHubNetwork.join(' ')]: listed('stray-app org.opencontainers.image.revision=1'),
      // What is still there after the teardown; `unrelated` was never reset's to remove.
      'ps -a --format {{.Names}}': listed('ci-hermes-1\nstray-app\nci-hub\nunrelated'),
      'ps -a --filter label=com.docker.compose.project=ci-hub --format {{.Names}}': listed('ci-hub'),
    };

    await expect(resetHub('prod', true)).resolves.toBe(false);

    expect(box('Reset complete')).toBeUndefined();
    expect(box('Reset incomplete')?.lines).toEqual(
      expect.arrayContaining(['Containers still there: ci-hermes-1, stray-app, ci-hub', '  docker rm -f ci-hermes-1 stray-app ci-hub']),
    );
    expect(process.exitCode).toBe(1);
  });

  it('does not print "Reset complete" when Docker cannot list what is left', async () => {
    state.rootContainerDeletes = true;
    state.listings = { 'ps -a --format {{.Names}}': { ok: false, stdout: '' } };

    await expect(resetHub('prod', true)).resolves.toBe(false);

    expect(box('Reset complete')).toBeUndefined();
    expect(box('Reset incomplete')?.lines).toEqual(
      expect.arrayContaining(['Docker did not list its containers and volumes, so reset could not check that they were removed.']),
    );
    expect(process.exitCode).toBe(1);
  });

  it('says the GPU probe timer writes state/hardware again, when that timer is installed', async () => {
    // cihub-gpu-processes.timer recreated `companion-hub/state/hardware` within 15 s on 13 fleet
    // nodes after the 2026-09-26 resets, and operators moved each folder aside by hand.
    state.rootContainerDeletes = true;
    const unitDir = path.join(state.home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(path.join(unitDir, 'cihub-gpu-processes.timer'), '[Timer]\nOnUnitActiveSec=15s\n');

    await expect(resetHub('prod', true)).resolves.toBe(true);

    expect(box('Reset complete')?.lines).toEqual(
      expect.arrayContaining([
        `cihub-gpu-processes.timer writes ${path.join(state.dataDir, 'state', 'hardware')} again within 15 s. That is expected; ` +
          '`cihub up` creates the new install beside it, so the folder does not need to be moved aside.',
      ]),
    );
  });

  describe('a checkout root folder that must not be deleted', () => {
    // ROOT_FOLDER_HOST comes from an env file or the environment. A typo there must not reach
    // `rm -rf`, nor the root container that deletes whatever the user could not.
    let repo: string;
    let outsideParent: string;

    beforeEach(() => {
      state.appliance = false;
      state.rootContainerDeletes = true;
      repo = path.join(state.home, 'repo');
      mkdirSync(repo);
      writeFileSync(path.join(repo, 'package.json'), '{}\n');
      writeFileSync(path.join(state.home, 'keep.txt'), 'x');
      outsideParent = mkdtempSync(path.join(tmpdir(), 'cli-reset-outside-'));
      process.chdir(repo);
    });

    afterEach(() => {
      rmSync(outsideParent, { recursive: true, force: true });
    });

    /** `~/alias`, a symlink to home itself, so `~/alias/repo` is the repository. */
    const symlinkedHome = () => {
      const alias = path.join(state.home, 'alias');
      if (!existsSync(alias)) symlinkSync(state.home, alias);
      return alias;
    };

    it.each([
      ['a folder outside the repository and home', () => path.join(outsideParent, 'hub-data'), 'is not inside the repository or your home directory'],
      ['the home directory', () => state.home, 'is this repository or holds it'],
      ['the repository itself (ROOT_FOLDER_HOST=.)', () => '.', 'is this repository or holds it'],
      // The repository through another spelling of its path, which reads as a folder inside home.
      // process.cwd() reports the real path (on macOS the temp folder's /var is itself a symlink).
      ['the repository through a symlink inside home', () => path.join(symlinkedHome(), 'repo'), 'is this repository or holds it'],
    ])('refuses %s, and starts no root container', (_name, rootFolderHost, why) => {
      // As resolveRootFolderHost resolves it.
      const target = path.isAbsolute(rootFolderHost()) ? rootFolderHost() : path.resolve(process.cwd(), rootFolderHost());
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'keep-me'), 'x');
      writeFileSync(path.join(repo, '.env.dev'), `ROOT_FOLDER_HOST=${rootFolderHost()}\n`);

      cleanHub('dev');

      expect(existsSync(path.join(target, 'keep-me'))).toBe(true);
      expect(existsSync(path.join(state.home, 'keep.txt'))).toBe(true);
      expect(existsSync(path.join(repo, 'package.json'))).toBe(true);
      expect(rootContainerRuns()).toEqual([]);
      expect(box('Host data left behind')?.lines).toEqual(expect.arrayContaining([expect.stringContaining(`${target}: it ${why}`)]));
      expect(process.exitCode).toBe(1);
    });
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
      // As above: nothing from the machine running the tests may choose the engine or the unit dir.
      vi.stubEnv('DOCKER_HOST', '');
      vi.stubEnv('CI_HUB_DOCKER_HOST', '');
      vi.stubEnv('XDG_CONFIG_HOME', '');
      state.appliance = true;
      share = path.join(state.home, '.local', 'share');
      state.dataDir = path.join(share, 'companion-hub');
      tunnel = path.join(share, 'tunnel');
      state.calls = [];
      state.dockerHosts = [];
      state.rootContainerDeletes = false;
      state.rootContainerStarts = true;
      state.listings = {};
      vi.clearAllMocks();
      mkdirSync(path.join(state.dataDir, 'state'), { recursive: true });
      writeFileSync(path.join(state.dataDir, '.env'), 'X=1\n');
      writeFileSync(path.join(state.dataDir, 'docker-compose.prod.yml'), 'services: {}\n');
      mkdirSync(path.join(share, 'other-app'));
      writeFileSync(path.join(share, 'other-app', 'data'), 'keep');
    });

    afterEach(() => {
      process.env.HOME = previousHome;
      vi.unstubAllEnvs();
      process.exitCode = undefined;
      for (const folder of state.lockedFolders.splice(0)) {
        if (existsSync(folder)) chmodSync(folder, 0o755);
      }
      rmSync(state.home, { recursive: true, force: true });
    });

    it('deletes the token, registration.json, and the empty certs/, then the folder, and says "Reset complete"', async () => {
      writeTunnel(tunnel);
      expect(await upWouldStartTheOldTunnel(state.dataDir)).toBe(true);

      await expect(resetHub('prod', true)).resolves.toBe(true);

      // The check `cihub up` makes before it turns on the cloudflare profile, unmocked.
      expect(await upWouldStartTheOldTunnel(state.dataDir)).toBe(false);
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
