import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The .deb's preinst and postinst give the package's folders back to root, because 0.3.5 and 0.3.6
 * installed them owned by uid 1001 and dpkg leaves an existing folder's owner alone on upgrade.
 *
 * The repair runs as root over everything `dpkg-query -L` lists under /usr, and that list includes
 * folders other packages share (/usr/share/applications, the hicolor icon folders). Those are not the
 * package's to change. Run here against a scratch tree through DPKG_ROOT, with dpkg-query, stat, chown
 * and rm replaced by stubs that read fixtures and log, so no test needs root or a real dpkg database.
 */
const DEB_DIR = path.resolve(import.meta.dirname, '../../packages/desktop/src-tauri/linux/deb');
const BLOCK = /# BEGIN root-owned package folders[^\n]*\n([\s\S]*?)# END root-owned package folders/;

function repairBlock(script: 'preinst' | 'postinst'): string {
  const match = BLOCK.exec(readFileSync(path.join(DEB_DIR, script), 'utf-8'));
  if (!match?.[1]) throw new Error(`no root-owned package folders block in ${script}`);
  return match[1];
}

const PACKAGE = 'companion-hub';

/** What 0.3.6 lists, as `dpkg-query -L` prints it. */
const LISTED = [
  '/.',
  '/usr',
  '/usr/bin',
  '/usr/bin/companion-hub',
  '/usr/lib',
  '/usr/lib/Companion Hub',
  '/usr/lib/Companion Hub/resources',
  '/usr/lib/Companion Hub/resources/cihub',
  '/usr/share',
  '/usr/share/applications',
  '/usr/share/applications/Companion Hub.desktop',
  '/usr/share/icons/hicolor/128x128/apps',
  '/usr/share/icons/hicolor/128x128/apps/companion-hub.png',
  '/usr/share/icons/hicolor/256x256@2/apps',
  '/usr/share/metainfo',
];

/** `dpkg-query -S` for the folders other packages list too. Everything else is this package's alone. */
const SHARED: Record<string, string> = {
  '/usr': 'base-files, companion-hub',
  '/usr/bin': 'coreutils, companion-hub',
  '/usr/lib': 'libc6, companion-hub',
  '/usr/share': 'base-files, companion-hub',
  '/usr/share/applications': 'desktop-file-utils, gnome-shell, companion-hub',
  '/usr/share/icons/hicolor/128x128/apps': 'hicolor-icon-theme, companion-hub',
  '/usr/share/metainfo': 'appstream, companion-hub',
};

let fixture: string;
let root: string;
let stubs: string;

function stub(name: string, body: string) {
  const file = path.join(stubs, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'deb-maint-'));
  root = path.join(fixture, 'root');
  stubs = path.join(fixture, 'bin');
  mkdirSync(stubs);
  writeFileSync(path.join(fixture, 'list'), `${LISTED.join('\n')}\n`);
  writeFileSync(
    path.join(fixture, 'shared'),
    Object.entries(SHARED)
      .map(([p, owners]) => `${p}\t${owners}`)
      .join('\n'),
  );
  writeFileSync(path.join(fixture, 'log'), '');
  stub(
    'dpkg-query',
    [
      'case "$1" in',
      '  -L) cat "$FIXTURE/list" ;;',
      '  -S) [ "$2" = "--" ] && shift; owners=$(awk -F "\\t" -v p="$2" \'$1 == p { print $2 }\' "$FIXTURE/shared"); printf "%s: %s\\n" "${owners:-companion-hub}" "$2" ;;',
      'esac',
    ].join('\n'),
  );
  // Owners come from the fixture, keyed by the path the package lists (without DPKG_ROOT), so a
  // script that ignores DPKG_ROOT still sees them. A path with no entry is root's.
  stub(
    'stat',
    [
      'eval "p=\\${$#}"',
      'logical=${p#"${DPKG_ROOT:-}"}',
      'owner=$(awk -F "\\t" -v p="$logical" \'$1 == p { print $2 }\' "$FIXTURE/owners" 2>/dev/null)',
      'owner=${owner:-0:0}',
      'case "$2" in %u) echo "${owner%%:*}" ;; *) echo "$owner" ;; esac',
    ].join('\n'),
  );
  stub('chown', 'echo "chown $*" >> "$FIXTURE/log"');
  stub('rm', 'echo "rm $*" >> "$FIXTURE/log"');
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

/** Folders and files on disk under DPKG_ROOT, and the uid:gid the stat stub reports for each. */
function layout(entries: Record<string, { kind: 'dir' | 'file' | 'symlink'; owner?: string }>) {
  const owners: string[] = [];
  for (const [logical, { kind, owner }] of Object.entries(entries)) {
    const onDisk = path.join(root, logical);
    mkdirSync(path.dirname(onDisk), { recursive: true });
    if (kind === 'dir') mkdirSync(onDisk, { recursive: true });
    if (kind === 'file') writeFileSync(onDisk, '');
    if (kind === 'symlink') symlinkSync(fixture, onDisk);
    if (owner) owners.push(`${logical}\t${owner}`);
  }
  writeFileSync(path.join(fixture, 'owners'), owners.join('\n'));
}

function runRepair(script: 'preinst' | 'postinst'): string[] {
  execFileSync('sh', ['-c', `set -eu\nPACKAGE=${PACKAGE}\n${repairBlock(script)}\nrestore_root_owned_folders`], {
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, DPKG_ROOT: root, FIXTURE: fixture, DPKG_MAINTSCRIPT_PACKAGE: PACKAGE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return readFileSync(path.join(fixture, 'log'), 'utf-8').split('\n').filter(Boolean);
}

/** An upgrade from 0.3.6: every folder dpkg created for the package belongs to uid 1001. */
const upgradedFrom036 = {
  '/usr/bin': { kind: 'dir' as const },
  '/usr/bin/companion-hub': { kind: 'file' as const, owner: '1001:1001' },
  '/usr/lib/Companion Hub': { kind: 'dir' as const, owner: '1001:1001' },
  '/usr/lib/Companion Hub/resources': { kind: 'dir' as const, owner: '1001:1001' },
  '/usr/lib/Companion Hub/resources/cihub': { kind: 'file' as const, owner: '1001:1001' },
  // Shared, and handed to uid 1001 by someone else: not this package's to change.
  '/usr/share/applications': { kind: 'dir' as const, owner: '1001:1001' },
  '/usr/share/icons/hicolor/128x128/apps': { kind: 'dir' as const, owner: '1001:1001' },
  // Only this package lists it, so 0.3.6 created it, owned by uid 1001.
  '/usr/share/icons/hicolor/256x256@2/apps': { kind: 'dir' as const, owner: '1001:1001' },
  '/usr/share/metainfo': { kind: 'dir' as const },
};

describe.skipIf(process.platform === 'win32')('the .deb maintainer scripts give the package folders back to root', () => {
  it('keeps the repair identical in preinst and postinst', () => {
    expect(repairBlock('preinst')).toBe(repairBlock('postinst'));
  });

  for (const script of ['preinst', 'postinst'] as const) {
    it(`${script}: chowns only the folders this package alone lists, never shared ones or files`, () => {
      layout(upgradedFrom036);

      const log = runRepair(script);

      expect(log.sort()).toEqual(
        [
          `chown -h root:root ${root}/usr/lib/Companion Hub`,
          `chown -h root:root ${root}/usr/lib/Companion Hub/resources`,
          `chown -h root:root ${root}/usr/share/icons/hicolor/256x256@2/apps`,
        ].sort(),
      );
    });
  }

  it("removes a symlink uid 1001 planted at one of the package's own folders, not one at a shared folder", () => {
    layout({
      '/usr/lib/Companion Hub': { kind: 'dir', owner: '0:0' },
      '/usr/lib/Companion Hub/resources': { kind: 'symlink', owner: '1001:1001' },
      '/usr/share/metainfo': { kind: 'symlink', owner: '1001:1001' },
    });

    const log = runRepair('postinst');

    expect(log).toEqual([`rm -f ${root}/usr/lib/Companion Hub/resources`]);
  });

  it('does nothing on an install whose folders are already root', () => {
    layout({
      '/usr/lib/Companion Hub': { kind: 'dir' },
      '/usr/lib/Companion Hub/resources': { kind: 'dir' },
      '/usr/share/applications': { kind: 'dir' },
    });

    expect(runRepair('postinst')).toEqual([]);
  });
});
