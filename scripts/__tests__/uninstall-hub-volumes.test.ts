/**
 * Which Docker volumes the Linux uninstall scripts remove.
 *
 * They matched volume names by substring, so a purge also removed a database copy kept as
 * `ci_hub_pgdata_backup` and the database of a CI-OS test deploy (`ci-os-hub-staging_ci_hub_pgdata`).
 * They now take every volume compose labelled for the Hub's compose project (ci-hub, or ci-os-hub before the
 * rename), plus the Hub stack's three volumes by their whole names (isHubStackVolume in
 * scripts/hub-cleanup-lib.ts, which `cihub reset` uses).
 *
 * Each script runs for real in a sandbox, as in uninstall-tunnel-cleanup.test.ts: PATH holds only a few
 * coreutils, a fake `getent` that lists one temp home and a fake `docker` that answers `volume ls` from
 * a fixture and records `volume rm`. The real engine and the real homes are out of reach.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHubStackVolume } from '../hub-cleanup-lib';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf-8');

const LINUX_SCRIPTS = {
  deb: 'packages/desktop/src-tauri/linux/deb/postrm',
  rpm: 'packages/desktop/src-tauri/linux/rpm/postun',
  aur: 'distribution/aur/companion-hub-bin.install',
  snap: 'snap/hooks/remove',
  shared: 'distribution/scripts/uninstall-cleanup.sh',
} as const;

const BEGIN = '# BEGIN hub docker volume list';
const END = '# END hub docker volume list';

function extractBlock(source: string, file: string): string {
  const start = source.indexOf(BEGIN);
  expect(start, `${BEGIN} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(END, start);
  expect(end, `${END} not found in ${file}`).toBeGreaterThan(start);
  return source.slice(start, end + END.length);
}

const dedent = (block: string) =>
  block
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n');

function findExecutable(tool: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Volumes on the engine, with the compose project each is labelled for ('' for none). */
const HUB_VOLUMES: [string, string][] = [
  // As compose creates them for an installed Hub (names pinned, project ci-hub).
  ['ci_hub_pgdata', 'ci-hub'],
  // As the desktop app creates it before compose does.
  ['hub_tailscale_state', ''],
  // From the old named-volume migration.
  ['ci_hub_app_data', ''],
  // A checkout's stack, where compose puts the project name in front.
  ['ci-hub_ci_hub_pgdata', 'ci-hub'],
  // A volume declared in the operator's hub-compose.yml, in the Hub's own project.
  ['ci-hub_hub_backups', 'ci-hub'],
  // Installs from before the rename to ci-hub, and an appliance that still carries its first project name.
  ['ci-os-hub_pgdata', 'ci-os-hub'],
  ['ci-os-hub_ci_hub_pgdata', ''],
  ['runtipi_ci_hub_pgdata', 'runtipi'],
];
const OTHER_VOLUMES: [string, string][] = [
  ['ci_hub_pgdata_backup', ''],
  ['ci-os-hub-staging_ci_hub_pgdata', 'ci-os-hub-staging'],
  ['ci-hub_ci_hub_pgdata_2026-11-24', ''],
  ['hub_tailscale_state_old', ''],
  ['myapp_ci_hub_app_data', 'myapp'],
  ['ci-os-hub-docs-cache', ''],
  ['postgres_data', ''],
  // Runtipi, a separate product, names its compose project runtipi too.
  ['runtipi_db_data', 'runtipi'],
  // A volume plugin can name a volume like this. Read into the shared script's `sh -c`, it would run the rest.
  ['ci-hub_x;touch pwned', 'ci-hub'],
];

describe('Linux uninstall scripts list the Hub volumes', () => {
  it('carry an identical helper block', () => {
    const reference = dedent(extractBlock(read(LINUX_SCRIPTS.deb), LINUX_SCRIPTS.deb));
    for (const [name, file] of Object.entries(LINUX_SCRIPTS)) {
      const block = dedent(extractBlock(read(file), file));
      expect(block, `${name} helper drifted from the deb postrm copy`).toBe(reference);
    }
  });

  it.each(Object.entries(LINUX_SCRIPTS))('%s removes volumes only from that list, never by part of a name', (_name, file) => {
    const source = read(file);
    expect(source).toMatch(/list_hub_volumes \| while IFS= read -r \w+; do/);
    expect(source).not.toMatch(/\*ci_hub_pgdata\*|\*ci-os-hub\*|\*hub_tailscale_state\*/);
  });

  it("names the same Hub stack volumes as cihub reset's isHubStackVolume", () => {
    const block = extractBlock(read(LINUX_SCRIPTS.deb), LINUX_SCRIPTS.deb);
    const keys = /for hub_key in ([^;]+);/.exec(block)?.[1]?.trim().split(/\s+/) ?? [];
    const prefixes = (/for hub_prefix in ([^;]+);/.exec(block)?.[1]?.trim().split(/\s+/) ?? []).map((prefix) => prefix.replace(/^''$/, ''));
    const names = keys.flatMap((key) => prefixes.map((prefix) => `${prefix}${key}`));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(isHubStackVolume(name), name).toBe(true);
    for (const [name] of [...HUB_VOLUMES, ...OTHER_VOLUMES]) {
      expect(names.includes(name), name).toBe(isHubStackVolume(name));
    }
  });
});

describe.skipIf(process.platform === 'win32')('Linux uninstall scripts in a sandbox remove the Hub volumes', () => {
  let sandbox: string;
  let bin: string;
  let shell: string;
  let bash: string | null;

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-hub-uninstall-volumes-'));
    bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    const realShell = findExecutable('sh');
    if (!realShell) throw new Error('sh not found');
    for (const tool of ['sh', 'awk', 'rm', 'rmdir', 'tr', 'base64', 'wc', 'grep', 'readlink', 'cat']) {
      const real = findExecutable(tool);
      if (!real) throw new Error(`${tool} not found on PATH`);
      fs.symlinkSync(real, path.join(bin, tool));
    }
    // pacman runs the AUR install script with bash.
    const realBash = findExecutable('bash');
    if (realBash) fs.symlinkSync(realBash, path.join(bin, 'bash'));
    bash = realBash ? path.join(bin, 'bash') : null;
    fs.writeFileSync(
      path.join(bin, 'getent'),
      `#!${realShell}\n[ "$1" = passwd ] || exit 2\nprintf 'hubtester:x:1000:1000::%s:/bin/sh\\n' "$FAKE_HOME"\n`,
      { mode: 0o755 },
    );
    // `volume ls [--filter label=com.docker.compose.project=<p>]` from the fixture, `volume rm` recorded,
    // and nothing for everything else (no containers, images or networks).
    fs.writeFileSync(
      path.join(bin, 'docker'),
      [
        `#!${realShell}`,
        '[ "$1" = volume ] || exit 0',
        'case "$2" in',
        '  ls)',
        '    shift 2; project=; other=',
        '    while [ $# -gt 0 ]; do',
        '      case "$1" in',
        '        --filter) case "$2" in label=com.docker.compose.project=*) project="${2#label=com.docker.compose.project=}" ;; *) other=1 ;; esac; shift 2 ;;',
        '        *) shift ;;',
        '      esac',
        '    done',
        '    [ -z "$other" ] || exit 0',
        `    awk -F '\\t' -v p="$project" 'p == "" || $2 == p { print $1 }' "$FAKE_VOLUMES" ;;`,
        '  rm) shift 2; for volume in "$@"; do printf \'%s\\n\' "$volume" >>"$FAKE_REMOVED"; done ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    shell = path.join(bin, 'sh');
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function run(command: string, args: string[]) {
    const work = fs.mkdtempSync(path.join(sandbox, 'run-'));
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    const volumes = path.join(work, 'volumes.tsv');
    fs.writeFileSync(volumes, [...HUB_VOLUMES, ...OTHER_VOLUMES].map(([name, project]) => `${name}\t${project}\n`).join(''));
    const removed = path.join(work, 'removed');
    const env = { PATH: bin, HOME: home, FAKE_HOME: home, FAKE_VOLUMES: volumes, FAKE_REMOVED: removed, LC_ALL: 'C' };
    const probe = spawnSync(shell, ['-c', 'command -v getent; command -v docker'], { encoding: 'utf-8', env });
    expect(probe.stdout).toBe(`${path.join(bin, 'getent')}\n${path.join(bin, 'docker')}\n`);
    const result = spawnSync(command, args, { cwd: home, encoding: 'utf-8', env });
    expect(result.status, result.stderr).toBe(0);
    return fs.existsSync(removed) ? fs.readFileSync(removed, 'utf-8').split('\n').filter(Boolean) : [];
  }

  const hubVolumeNames = HUB_VOLUMES.map(([name]) => name).sort();

  function expectHubVolumesOnly(removed: string[]) {
    expect([...removed].sort()).toEqual(hubVolumeNames);
  }

  // postrm's CLI-symlink step acts on /usr/bin/cihub, which only root could change.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)('deb postrm remove and purge remove the Hub volumes once each and keep the rest', () => {
    for (const action of ['remove', 'purge']) {
      expectHubVolumesOnly(run(shell, [path.join(repoRoot, LINUX_SCRIPTS.deb), action]));
    }
  });

  it('deb postrm upgrade removes no volume', () => {
    expect(run(shell, [path.join(repoRoot, LINUX_SCRIPTS.deb), 'upgrade'])).toEqual([]);
  });

  it('rpm postun on final erase removes the Hub volumes and keeps the rest', () => {
    expectHubVolumesOnly(run(shell, [path.join(repoRoot, LINUX_SCRIPTS.rpm), '0']));
  });

  it('rpm postun during an upgrade removes no volume', () => {
    expect(run(shell, [path.join(repoRoot, LINUX_SCRIPTS.rpm), '1'])).toEqual([]);
  });

  it('snap remove hook removes the Hub volumes and keeps the rest', () => {
    expectHubVolumesOnly(run(shell, [path.join(repoRoot, LINUX_SCRIPTS.snap)]));
  });

  it('AUR post_remove removes the Hub volumes and keeps the rest', () => {
    expectHubVolumesOnly(run(bash ?? shell, ['-c', '. "$1" && post_remove', 'sh', path.join(repoRoot, LINUX_SCRIPTS.aur)]));
  });

  it('shared uninstall-cleanup.sh removes the Hub volumes and keeps the rest', () => {
    expectHubVolumesOnly(run(shell, [path.join(repoRoot, LINUX_SCRIPTS.shared)]));
  });
});
