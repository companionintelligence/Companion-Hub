/**
 * Deleting host data when some of it belongs to another user.
 *
 * The fleet case (2026-09-26): containers wrote folders such as
 * `app-data/ci-marketplace/opencode/data/opencode/share/log` as root, the login user could not empty
 * them, and the recursive delete threw one EACCES naming only the top folder. These tests make the
 * same EACCES for real by removing write permission from a folder, so they skip when run as root
 * (root ignores the mode) and on Windows (no POSIX modes).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeBlockedFolders,
  findFoldersBlockingRemoval,
  removeHostDataTarget,
  rootRemovalCommand,
  summarizeFailures,
} from '../lib/host-data-removal';

const cannotSimulateEacces = process.platform === 'win32' || process.getuid?.() === 0;

describe.skipIf(cannotSimulateEacces)('removeHostDataTarget with folders the user cannot empty', () => {
  let root: string;
  let target: string;
  let locked: string;
  const lockedFolders: string[] = [];

  const lock = (folder: string) => {
    chmodSync(folder, 0o555);
    lockedFolders.push(folder);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'host-data-removal-'));
    target = path.join(root, 'companion-hub');
    locked = path.join(target, 'app-data', 'ci-marketplace', 'opencode', 'data', 'share', 'log');
    mkdirSync(locked, { recursive: true });
    writeFileSync(path.join(target, '.env'), 'POSTGRES_PASSWORD=x\n');
    writeFileSync(path.join(target, 'app-data', 'ci-marketplace', 'opencode', 'data', 'share', 'opencode.db'), 'db');
    writeFileSync(path.join(locked, 'a.log'), 'a');
    writeFileSync(path.join(locked, 'b.log'), 'b');
  });

  afterEach(() => {
    for (const folder of lockedFolders.splice(0)) {
      if (existsSync(folder)) chmodSync(folder, 0o755);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a tree the user owns without calling the root container', () => {
    const removeAsRoot = vi.fn(() => true);

    const result = removeHostDataTarget(target, { removeAsRoot });

    expect(result).toMatchObject({ removed: true, existed: true, rootContainer: 'not needed', blocked: [] });
    expect(existsSync(target)).toBe(false);
    expect(removeAsRoot).not.toHaveBeenCalled();
  });

  it('reports an absent target as removed and not as having existed', () => {
    const result = removeHostDataTarget(path.join(root, 'never-created'));

    expect(result).toMatchObject({ removed: true, existed: false });
  });

  it('names the exact folder that stopped it, with EACCES, and deletes everything else', () => {
    lock(locked);
    const removeAsRoot = vi.fn(() => true);

    const result = removeHostDataTarget(target, { removeAsRoot });

    expect(removeAsRoot).toHaveBeenCalledWith(target);
    expect(result.removed).toBe(false);
    expect(result.rootContainer).toBe('ran');
    expect(result.blocked).toEqual([{ folder: locked, code: 'EACCES', entries: 2, unlistable: false }]);
    expect(result.leftoverEntries).toBe(2);
    // What the user could delete is gone, secrets included; only the locked folder's path is left.
    expect(existsSync(path.join(target, '.env'))).toBe(false);
    expect(existsSync(path.join(target, 'app-data', 'ci-marketplace', 'opencode', 'data', 'share', 'opencode.db'))).toBe(false);
    expect(existsSync(path.join(locked, 'a.log'))).toBe(true);
  });

  it('counts the target as removed when the root container deleted what the user could not', () => {
    lock(locked);
    const removeAsRoot = vi.fn((folder: string) => {
      // Stands in for `docker run --rm -v <folder>:/d alpine rm -rf /d/*` on a rootful daemon.
      chmodSync(locked, 0o755);
      rmSync(folder, { recursive: true, force: true });
      return true;
    });

    const result = removeHostDataTarget(target, { removeAsRoot });

    expect(result).toMatchObject({ removed: true, rootContainer: 'ran', blocked: [] });
    expect(existsSync(target)).toBe(false);
  });

  it('says so when Docker could not start the root container', () => {
    lock(locked);

    const result = removeHostDataTarget(target, { removeAsRoot: () => false });

    expect(result.removed).toBe(false);
    expect(result.rootContainer).toBe('did not start');
  });

  it('reports only the top-most folder when locked folders nest', () => {
    const inner = path.join(locked, 'nested');
    mkdirSync(inner);
    writeFileSync(path.join(inner, 'c.log'), 'c');
    lock(inner);
    lock(locked);

    const result = removeHostDataTarget(target);

    expect(result.blocked.map((folder) => folder.folder)).toEqual([locked]);
  });

  it('reports a folder it cannot list as unlistable', () => {
    lock(locked);
    chmodSync(locked, 0o000);

    const result = removeHostDataTarget(target);

    expect(result.blocked).toEqual([{ folder: locked, code: 'EACCES', entries: 0, unlistable: true }]);
    expect(describeBlockedFolders(result.blocked)[0]).toMatch(new RegExp(`^EACCES ${escapeRegExp(locked)}: cannot be listed, owned by uid \\d+$`));
  });

  it('unlinks a symlink out of the tree rather than following it, even inside a folder it cannot empty', () => {
    // The walk only runs once the plain delete has failed, so the link sits in the locked folder,
    // where the plain delete cannot unlink it first. Followed, the walk would delete `outside/`.
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, path.join(locked, 'link'));
    lock(locked);

    const result = removeHostDataTarget(target, { removeAsRoot: () => true });

    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.blocked).toEqual([{ folder: locked, code: 'EACCES', entries: 3, unlistable: false }]);
    expect(findFoldersBlockingRemoval(target).map((folder) => folder.folder)).toEqual([locked]);
  });

  it('finds the same folder for --dry-run without deleting anything', () => {
    lock(locked);

    expect(findFoldersBlockingRemoval(target)).toEqual([{ folder: locked, code: 'EACCES', entries: 2, unlistable: false }]);
    expect(existsSync(path.join(target, '.env'))).toBe(true);
    expect(findFoldersBlockingRemoval(path.join(root, 'never-created'))).toEqual([]);
  });
});

describe('summarizeFailures', () => {
  it('blames the parent folder for permission errors and the entry itself for a busy mount', () => {
    const blocked = summarizeFailures([
      { path: '/d/app-data/x/log/a.log', code: 'EACCES', op: 'remove' },
      { path: '/d/app-data/x/log/b.log', code: 'EACCES', op: 'remove' },
      { path: '/d/app-data/x/log/sub/c.log', code: 'EACCES', op: 'remove' },
      { path: '/d/models', code: 'EBUSY', op: 'remove' },
    ]);

    expect(blocked).toEqual([
      { folder: '/d/app-data/x/log', code: 'EACCES', entries: 2, unlistable: false },
      { folder: '/d/models', code: 'EBUSY', entries: 0, unlistable: false },
    ]);
    expect(describeBlockedFolders(blocked)[1]).toBe('EBUSY /d/models: in use, or a mount point');
  });
});

describe('describeBlockedFolders', () => {
  it('caps the list and says how many more folders there are', () => {
    const blocked = Array.from({ length: 11 }, (_, index) => ({ folder: `/nope/${index}`, code: 'EACCES', entries: 1, unlistable: false }));

    const lines = describeBlockedFolders(blocked, 8);

    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('EACCES /nope/0: 1 entry in it cannot be deleted');
    expect(lines[8]).toBe('…and 3 more folders');
  });
});

describe('rootRemovalCommand', () => {
  it('quotes the path for the shell, including a single quote in it', () => {
    expect(rootRemovalCommand('/home/ci/.local/share/companion-hub', 'linux')).toBe("sudo rm -rf -- '/home/ci/.local/share/companion-hub'");
    expect(rootRemovalCommand("/home/o'neil/companion-hub", 'linux')).toBe("sudo rm -rf -- '/home/o'\\''neil/companion-hub'");
  });

  it("doubles a single quote for PowerShell, where the POSIX '\\'' form is a syntax error", () => {
    expect(rootRemovalCommand("C:\\Users\\O'Brien\\AppData\\Roaming\\companion-hub", 'win32')).toBe(
      "Remove-Item -Recurse -Force -LiteralPath 'C:\\Users\\O''Brien\\AppData\\Roaming\\companion-hub'   (in an administrator PowerShell)",
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
