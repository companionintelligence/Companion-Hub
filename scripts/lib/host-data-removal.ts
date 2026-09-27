/**
 * Deleting a Hub's host data folders, and saying exactly what survived.
 *
 * App and Hub containers write into the data folder as root, or as a container user that is not
 * the login user, so `cihub reset` and `cihub clean` often cannot delete all of it. The recursive
 * delete then throws one error that names the top folder, not the entry that failed: on 15 of 17
 * fleet nodes (2026-09-26) the Bun-compiled `cihub` reported
 * `EACCES: permission denied, rm '/home/ci/.local/share/companion-hub'` while the files it could
 * not delete were several levels down (`app-data/ci-marketplace/opencode/data/opencode/share/log`,
 * owned by root). That error was printed and the reset still said the host data had been removed.
 *
 * This module deletes what it can, reports each folder that stopped it with the errno and the
 * folder owner, and gives the command that finishes the job.
 */
import { accessSync, constants, type Dirent, existsSync, lstatSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { hubFilesInTunnelDir, isEmptyRealDir } from '../hub-cleanup-lib.js';

/** One entry the login user could not delete, or one folder it could not list. */
export type RemovalFailure = {
  path: string;
  /** errno code (EACCES, EPERM, EBUSY, …). */
  code: string;
  /** `list` when reading the folder failed, so nothing below it is known. */
  op: 'list' | 'remove';
};

/** A folder that stopped the delete, with the entries directly in it that are left. */
export type BlockedFolder = {
  folder: string;
  code: string;
  /** Entries directly in `folder` that could not be deleted. 0 when the folder could not be listed. */
  entries: number;
  unlistable: boolean;
};

export type HostDataRemoval = {
  target: string;
  /** False when the target did not exist, so there was nothing to delete. */
  existed: boolean;
  /**
   * True only when the target is gone now. For a folder the Hub shares with other programs
   * (`shared` is set), true when none of the Hub's entries are left in it.
   */
  removed: boolean;
  /**
   * Whether the delete needed the root container, and whether Docker started it. The container
   * exits 0 even when it deletes nothing (rootless Docker maps its root to the login user), so
   * `ran` does not mean it succeeded; `removed` says that.
   */
  rootContainer: 'not needed' | 'ran' | 'did not start';
  /** Why the target was not touched at all, such as a path outside the allowed folders. */
  refused?: string;
  /** What is left and why, grouped by the folder that stopped the delete. Empty when removed. */
  blocked: BlockedFolder[];
  /** Entries still present that the login user could not delete. */
  leftoverEntries: number;
  /**
   * Set for a folder only part of which is the Hub's: the tunnel folder beside an appliance data
   * dir (removeHubTunnelFiles). Reset deletes the Hub's entries in it and leaves the rest.
   */
  shared?: {
    /** The Hub's entries deleted, ending with `certs/` and the folder itself when they were empty. */
    deleted: string[];
    /** Entries that are not the Hub's, left in place. */
    kept: string[];
    /** The Hub's entries still there, ending with the folder itself when nothing else holds it. */
    left: string[];
    /** Deletes the Hub's entries that are left, and nothing else. Unset when none are left. */
    finishCommand?: string;
  };
};

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function removeEntry(entry: string, failures: RemovalFailure[]): boolean {
  let isDirectory: boolean;
  try {
    // lstat, so a symlink is unlinked rather than followed out of the data folder.
    isDirectory = lstatSync(entry).isDirectory();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    failures.push({ path: entry, code: errnoCode(error), op: 'remove' });
    return false;
  }
  if (isDirectory) {
    let names: string[];
    try {
      names = readdirSync(entry);
    } catch (error) {
      failures.push({ path: entry, code: errnoCode(error), op: 'list' });
      return false;
    }
    let emptied = true;
    for (const name of names) {
      if (!removeEntry(path.join(entry, name), failures)) emptied = false;
    }
    // A folder that still holds survivors fails with ENOTEMPTY. That is a consequence, not a cause,
    // and reporting it would bury the entries that actually could not be deleted.
    if (!emptied) return false;
  }
  try {
    if (isDirectory) rmdirSync(entry);
    else unlinkSync(entry);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    failures.push({ path: entry, code: errnoCode(error), op: 'remove' });
    return false;
  }
}

/**
 * Deletes `target` entry by entry, carrying on past failures, and returns every entry it could not
 * delete with the errno that stopped it. An empty list means the target is gone.
 */
export function removeTreeReportingFailures(target: string): RemovalFailure[] {
  const failures: RemovalFailure[] = [];
  removeEntry(target, failures);
  return failures;
}

/** Permission errors on unlink and rmdir are about the folder holding the entry, not the entry. */
function isParentPermissionError(code: string): boolean {
  return code === 'EACCES' || code === 'EPERM';
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${path.sep}`);
}

/**
 * Groups failures by the folder that caused them and keeps only the top-most ones: once a folder
 * cannot be emptied, everything under it needs the same fix, and one root-owned `node_modules`
 * would otherwise fill the report.
 */
export function summarizeFailures(failures: RemovalFailure[]): BlockedFolder[] {
  const groups = new Map<string, BlockedFolder>();
  for (const failure of failures) {
    const folder = failure.op === 'list' || !isParentPermissionError(failure.code) ? failure.path : path.dirname(failure.path);
    const key = `${folder}\0${failure.code}`;
    const group = groups.get(key) ?? { folder, code: failure.code, entries: 0, unlistable: false };
    if (failure.op === 'list') group.unlistable = true;
    else if (group.folder !== failure.path) group.entries += 1;
    groups.set(key, group);
  }
  const topMost: BlockedFolder[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.folder.localeCompare(b.folder))) {
    if (topMost.some((kept) => kept.folder !== group.folder && isWithin(kept.folder, group.folder))) continue;
    topMost.push(group);
  }
  return topMost;
}

/**
 * The folders under `target` that the login user cannot empty, found without deleting anything, for
 * `cihub reset --dry-run`. It predicts only permission failures; a busy mount shows up only when the
 * real delete runs.
 */
export function findFoldersBlockingRemoval(target: string): BlockedFolder[] {
  // Windows access checks only look at the read-only attribute, so they predict nothing useful.
  if (process.platform === 'win32' || !existsSync(target)) return [];
  const blocked: BlockedFolder[] = [];
  const parent = path.dirname(target);
  if (!canModify(parent)) {
    blocked.push({ folder: parent, code: 'EACCES', entries: 1, unlistable: false });
  }
  const visit = (folder: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      blocked.push({ folder, code: errnoCode(error), entries: 0, unlistable: true });
      return;
    }
    if (entries.length === 0) return;
    if (!canModify(folder)) {
      blocked.push({ folder, code: 'EACCES', entries: entries.length, unlistable: false });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(folder, entry.name));
    }
  };
  if (lstatOrUndefined(target)?.isDirectory()) visit(target);
  return blocked;
}

/** Whether the login user can create and delete entries in `folder`. */
export function canModify(folder: string): boolean {
  try {
    accessSync(folder, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lstatOrUndefined(target: string) {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

function ownerOf(folder: string): string {
  if (process.platform === 'win32') return '';
  const uid = lstatOrUndefined(folder)?.uid;
  if (uid === undefined) return '';
  return uid === 0 ? ', owned by root' : `, owned by uid ${uid}`;
}

/** One line per blocking folder, capped so a large tree cannot flood the terminal. */
export function describeBlockedFolders(blocked: BlockedFolder[], limit = 8): string[] {
  const lines = blocked.slice(0, limit).map(({ folder, code, entries, unlistable }) => {
    if (unlistable) return `${code} ${folder}: cannot be listed${ownerOf(folder)}`;
    if (entries > 0) return `${code} ${folder}: ${entries} ${entries === 1 ? 'entry' : 'entries'} in it cannot be deleted${ownerOf(folder)}`;
    // Not a permission problem on the parent: the entry itself is busy, mounted, or read-only.
    return `${code} ${folder}${code === 'EBUSY' ? ': in use, or a mount point' : ''}`;
  });
  if (blocked.length > limit) lines.push(`…and ${blocked.length - limit} more folders`);
  return lines;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that finishes the delete as an administrator. */
export function rootRemovalCommand(target: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `Remove-Item -Recurse -Force -LiteralPath ${shellQuote(target)}   (in an administrator PowerShell)`;
  return `sudo rm -rf -- ${shellQuote(target)}`;
}

/**
 * Deletes these files, then these folders once they are empty, as an administrator. Never
 * recursive: it is for a folder that also holds another program's files.
 */
export function rootEntryRemovalCommand(files: string[], folders: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `Remove-Item -Force -LiteralPath ${[...files, ...folders].map(shellQuote).join(', ')}   (in an administrator PowerShell)`;
  }
  const steps: string[] = [];
  if (files.length > 0) steps.push(`sudo rm -f -- ${files.map(shellQuote).join(' ')}`);
  if (folders.length > 0) steps.push(`sudo rmdir -- ${folders.map(shellQuote).join(' ')}`);
  return steps.join(' && ');
}

/** The command that finishes a target left behind, or undefined when there is none to give. */
export function finishRemovalCommand(result: HostDataRemoval): string | undefined {
  if (result.shared) return result.shared.finishCommand;
  return result.refused ? undefined : rootRemovalCommand(result.target);
}

/**
 * Deletes `target`. When the login user cannot delete all of it, `removeAsRoot` gets a turn (the
 * caller's throwaway root container), and whatever still survives is deleted entry by entry so the
 * report names the exact folders left and why. `removeAsRoot` returns whether it could start.
 */
export function removeHostDataTarget(target: string, options: { removeAsRoot?: (target: string) => boolean } = {}): HostDataRemoval {
  const outcome = (fields: Partial<HostDataRemoval>): HostDataRemoval => ({
    target,
    existed: true,
    removed: false,
    rootContainer: 'not needed',
    blocked: [],
    leftoverEntries: 0,
    ...fields,
  });
  if (!existsSync(target)) return outcome({ existed: false, removed: true });

  const tryRecursiveDelete = () => {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Its error names only `target`, whatever failed below it; the walk below finds the real entries.
    }
    return !existsSync(target);
  };
  if (tryRecursiveDelete()) return outcome({ removed: true });

  let rootContainer: HostDataRemoval['rootContainer'] = 'not needed';
  if (options.removeAsRoot) {
    rootContainer = options.removeAsRoot(target) ? 'ran' : 'did not start';
    if (tryRecursiveDelete()) return outcome({ removed: true, rootContainer });
  }

  const failures = removeTreeReportingFailures(target);
  if (!existsSync(target)) return outcome({ removed: true, rootContainer });
  return outcome({ rootContainer, blocked: summarizeFailures(failures), leftoverEntries: failures.length });
}

/** Created empty by the backend next to the token (cloudflare-client.service.ts). */
const TUNNEL_CERTS_DIR = 'certs';

export type TunnelDirContents = {
  /** `symlink` and `other` (a file) are never reached into or deleted. */
  kind: 'absent' | 'folder' | 'symlink' | 'other';
  /** The Hub's files in it; for a symlink, the ones behind the link. */
  hubFiles: string[];
  /** Entries that are not the Hub's, including anything in `certs/`. */
  kept: string[];
};

function listOrEmpty(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/**
 * What in the tunnel folder beside a data dir is the Hub's. `tunnel` is a generic name, so this uses
 * `cihub uninstall`'s rules (hubFilesInTunnelDir): the token only when it is a cloudflared token,
 * the markers only when they hold a tunnelId, no symlinked file. `certs/` is the Hub's only while it
 * is empty; everything else is kept.
 */
export function inspectTunnelDir(tunnelDir: string): TunnelDirContents {
  const stat = lstatOrUndefined(tunnelDir);
  if (!stat) return { kind: 'absent', hubFiles: [], kept: [] };
  if (stat.isSymbolicLink()) {
    // Read through the link to report what is behind it. Nothing is ever deleted through it.
    let pointsToFolder = false;
    try {
      pointsToFolder = statSync(tunnelDir).isDirectory();
    } catch {
      // A dangling link holds nothing.
    }
    return { kind: 'symlink', hubFiles: pointsToFolder ? hubFilesInTunnelDir(tunnelDir) : [], kept: [tunnelDir] };
  }
  if (!stat.isDirectory()) return { kind: 'other', hubFiles: [], kept: [tunnelDir] };
  const hubFiles = hubFilesInTunnelDir(tunnelDir);
  const kept: string[] = [];
  for (const name of listOrEmpty(tunnelDir)) {
    const entry = path.join(tunnelDir, name);
    if (hubFiles.includes(entry)) continue;
    if (name === TUNNEL_CERTS_DIR && lstatOrUndefined(entry)?.isDirectory()) {
      kept.push(...listOrEmpty(entry).map((child) => path.join(entry, child)));
      continue;
    }
    kept.push(entry);
  }
  return { kind: 'folder', hubFiles, kept: kept.sort() };
}

/** The Hub's folders still there: `certs/` while empty, and the tunnel folder while it holds nothing else of anyone's. */
function hubFoldersLeft(tunnelDir: string, contents: TunnelDirContents): string[] {
  if (contents.kind !== 'folder') return [];
  const certs = path.join(tunnelDir, TUNNEL_CERTS_DIR);
  return [...(isEmptyRealDir(certs) ? [certs] : []), ...(contents.kept.length === 0 ? [tunnelDir] : [])];
}

/**
 * Deletes the Hub's files from the tunnel folder beside an appliance data dir (see
 * inspectTunnelDir), then `certs/` and the folder once each is empty, and reports what is left the
 * way removeHostDataTarget does. There is no root-container retry: that deletes a folder's whole
 * contents, and this folder can hold another program's files. A symlinked folder is not followed;
 * when the Hub's files sit behind it, the result is refused and names them.
 */
export function removeHubTunnelFiles(tunnelDir: string, platform: NodeJS.Platform = process.platform): HostDataRemoval {
  const before = inspectTunnelDir(tunnelDir);
  const outcome = (fields: Partial<HostDataRemoval>, shared: NonNullable<HostDataRemoval['shared']>): HostDataRemoval => ({
    target: tunnelDir,
    existed: true,
    removed: true,
    rootContainer: 'not needed',
    blocked: [],
    leftoverEntries: 0,
    ...fields,
    shared,
  });
  if (before.kind === 'absent') return outcome({ existed: false }, { deleted: [], kept: [], left: [] });
  if (before.kind !== 'folder') {
    if (before.hubFiles.length === 0) return outcome({}, { deleted: [], kept: before.kept, left: [] });
    const names = before.hubFiles.map((file) => path.basename(file)).join(', ');
    return outcome(
      {
        removed: false,
        refused: `it is a symlink, so it was not followed, and the Hub's files behind it are still there: ${names}`,
        leftoverEntries: before.hubFiles.length,
      },
      { deleted: [], kept: before.kept, left: before.hubFiles, finishCommand: rootEntryRemovalCommand(before.hubFiles, [], platform) },
    );
  }

  const failures: RemovalFailure[] = [];
  const deleted: string[] = [];
  const remove = (entry: string, folder: boolean) => {
    try {
      if (folder) rmdirSync(entry);
      else unlinkSync(entry);
      deleted.push(entry);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') failures.push({ path: entry, code: errnoCode(error), op: 'remove' });
    }
  };
  for (const file of before.hubFiles) remove(file, false);
  for (const folder of [path.join(tunnelDir, TUNNEL_CERTS_DIR), tunnelDir]) {
    if (isEmptyRealDir(folder)) remove(folder, true);
  }

  // The result is what a fresh look finds, not what the calls returned.
  const after = inspectTunnelDir(tunnelDir);
  const foldersLeft = hubFoldersLeft(tunnelDir, after);
  const left = [...after.hubFiles, ...foldersLeft];
  if (left.length === 0) return outcome({}, { deleted, kept: after.kept, left });
  return outcome(
    { removed: false, blocked: summarizeFailures(failures), leftoverEntries: left.length },
    { deleted, kept: after.kept, left, finishCommand: rootEntryRemovalCommand(after.hubFiles, foldersLeft, platform) },
  );
}
