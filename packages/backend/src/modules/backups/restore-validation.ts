import fs from 'node:fs';
import path from 'node:path';
import { pLimit } from '@/common/helpers/file-helpers';
import type { ArchiveEntry } from '@/core/archive/archive.service';

/**
 * What a restore will accept from a backup archive.
 *
 * A backup is produced by this system (`BackupManager.backupApp`) as three top-level
 * folders of plain files and directories (four with `volumes`, for an app's named Docker
 * volumes), but a restore also takes archives a user UPLOADED, so nothing about the
 * archive is trusted. Every rule here is checked
 * before any live app file is touched; a restore deletes the app's existing data first,
 * so the order — validate, then replace — is the whole point.
 */

/** The folders a backup archive may contain. Anything else at the top level is not ours. */
export const BACKUP_ROOT_FOLDERS = ['app-data', 'app', 'user-config', 'volumes'] as const;

/**
 * A file in `volumes`: one named Docker volume as a tar archive, named after the volume's key in the
 * app's compose file, which follows the rule a manifest's `volumeName` does. The restore streams the
 * file into a container unread, so that folder holds these files and nothing else.
 */
export const VOLUME_ARCHIVE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.tar$/;

/** One message for every rejected shape: the caller is told the backup is unusable, not how to tailor the next attempt. */
export const UNSAFE_BACKUP_MESSAGE = 'Backup contains unsupported file types';

const MISSING_FOLDER_MESSAGE = 'Backup is missing required folders';

/**
 * Refusal of an archive. The message is the one every rejected shape shares; `detail` names the entry
 * and the rule, for the log, because the toast the user sees cannot and the next question is always
 * "which file?".
 */
export class UnsafeBackupError extends Error {
  constructor(readonly detail: string) {
    super(UNSAFE_BACKUP_MESSAGE);
    this.name = 'UnsafeBackupError';
  }
}

const unsafe = (detail: string) => new UnsafeBackupError(detail);

/**
 * Where a symbolic link may live: inside `app-data`, below its top level.
 *
 * Apps make links in their own data (a Python virtualenv, `node_modules/.bin`, a `current` release
 * pointer), and the Hub's own backups carry them, so refusing every link would make a backup the Hub
 * wrote impossible to restore. The Hub never follows what is in there: it lists it with `lstat`, removes
 * it with `rm`, and copies it as a link. What it does follow is the files it manages itself, which sit
 * at the top of `app-data` (`app.env`), in `app` and in `user-config`: a link in any of those would be
 * written or read through. So those stay link-free.
 */
function mayHoldSymlink(entryPath: string): boolean {
  const segments = entryPath.split('/');

  return segments[0] === 'app-data' && segments.length >= 3;
}

/**
 * Reject an archive listing that could escape the extraction directory or smuggle a
 * non-file into it, without extracting anything.
 *
 * Only regular files (`-`), directories (`d`) and, in the places {@link mayHoldSymlink} allows,
 * symbolic links (`l`) are accepted. Hard links, devices and FIFOs are refused.
 *
 * ⚠ NOTHING MAY BE PLACED THROUGH A LINK. An archive that holds `app-data/data/x -> /etc` followed by
 * `app-data/data/x/cron.d/job` would have tar write outside the extraction directory, so any entry
 * whose path runs through a link of the same archive (or has the link's own path) is refused, wherever
 * in the listing the link comes.
 */
export function validateRestoreArchiveEntries(entries: ArchiveEntry[]): void {
  const symlinks = new Set<string>();
  const checked: Array<{ path: string; isLink: boolean }> = [];

  for (const entry of entries) {
    if (entry.type !== '-' && entry.type !== 'd' && entry.type !== 'l') {
      throw unsafe(`${entry.path}: entry type "${entry.type}" is not a file, directory or symbolic link`);
    }

    const entryPath = normalizeArchiveEntryPath(entry.path);

    if (entryPath === '.') {
      continue;
    }

    const rootFolder = entryPath.split('/')[0];

    if (!rootFolder || !(BACKUP_ROOT_FOLDERS as readonly string[]).includes(rootFolder)) {
      throw unsafe(`${entry.path}: not inside ${BACKUP_ROOT_FOLDERS.join(', ')}`);
    }

    if (rootFolder === 'volumes' && entryPath !== 'volumes' && !(entry.type === '-' && isVolumeArchive(entryPath))) {
      throw unsafe(`${entry.path}: the volumes folder holds only <volume>.tar files`);
    }

    if (entry.type === 'l') {
      if (!mayHoldSymlink(entryPath)) {
        throw unsafe(`${entry.path}: symbolic links are only restored inside the app's data folder`);
      }

      symlinks.add(entryPath);
    }

    checked.push({ path: entryPath, isLink: entry.type === 'l' });
  }

  for (const { path: entryPath, isLink } of checked) {
    const segments = entryPath.split('/');
    // A link is checked against the links above it, not against itself.
    const depth = isLink ? segments.length - 1 : segments.length;

    for (let length = 1; length <= depth; length++) {
      const prefix = segments.slice(0, length).join('/');

      if (symlinks.has(prefix)) {
        throw unsafe(`${entryPath}: placed through the symbolic link ${prefix}`);
      }
    }
  }
}

/** `volumes/<name>.tar`, directly in the folder. */
function isVolumeArchive(entryPath: string): boolean {
  const segments = entryPath.split('/');

  return segments.length === 2 && VOLUME_ARCHIVE_NAME.test(segments[1] ?? '');
}

function normalizeArchiveEntryPath(entryPath: string): string {
  if (entryPath.includes('\0') || path.posix.isAbsolute(entryPath)) {
    throw unsafe(`${entryPath.replaceAll('\0', '\\0')}: absolute or containing a NUL byte`);
  }

  const normalized = path.posix.normalize(entryPath.replace(/^(\.\/)+/, ''));

  if (normalized === '..' || normalized.startsWith('../')) {
    throw unsafe(`${entryPath}: climbs out of the extraction folder`);
  }

  return normalized === '.' ? normalized : normalized.replace(/\/+$/, '');
}

/**
 * The volume keys in an EXTRACTED backup's `volumes` folder, from its `<key>.tar` files. A backup
 * without the folder has none. Anything else in the folder is refused, including a hard link.
 */
export async function readVolumeArchiveKeys(directory: string): Promise<string[]> {
  await validateRestoreDirectory(directory, { required: false });

  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  });

  const keys: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !VOLUME_ARCHIVE_NAME.test(entry.name)) {
      throw unsafe(`volumes/${entry.name}: not a volume archive`);
    }

    // A tar of a volume holds at least its root folder. Busybox tar reads an empty file as an
    // empty archive, so the restore would empty the volume and put nothing back.
    if ((await fs.promises.lstat(path.join(directory, entry.name))).size === 0) {
      throw unsafe(`volumes/${entry.name}: empty`);
    }

    keys.push(entry.name.slice(0, -'.tar'.length));
  }

  return keys;
}

/**
 * Walk an EXTRACTED backup folder and reject anything that is not a plain file or
 * directory with a single link.
 *
 * The listing check ({@link validateRestoreArchiveEntries}) reads what tar says the
 * archive holds; this reads what is actually on disk, which is what the restore copies.
 * It is the only check that catches a hard link on busybox, whose verbose listing
 * prints one as an ordinary `-` entry.
 *
 * Throws if a `required` folder is absent, so a backup without its data is refused
 * before the live data is removed rather than after.
 */
export async function validateRestoreDirectory(
  directory: string,
  options: { required: boolean /** Allow symbolic links below the top level, where {@link mayHoldSymlink} would. */; symlinks?: boolean },
): Promise<void> {
  const limit = pLimit(16);

  const rootStats = await limit(() => fs.promises.lstat(directory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && !options.required) {
      return null;
    }

    if (error.code === 'ENOENT') {
      throw new Error(MISSING_FOLDER_MESSAGE);
    }

    throw error;
  });

  if (!rootStats) {
    return;
  }

  if (!rootStats.isDirectory()) {
    throw unsafe(`${path.basename(directory)}: not a plain folder`);
  }

  // The recursion itself is not rate-limited, only the filesystem calls inside it: a
  // limited task that awaited limited children would deadlock once the parents filled
  // every slot.
  const walk = async (current: string, depth: number): Promise<void> => {
    const entries = await limit(() => fs.promises.readdir(current, { withFileTypes: true }));

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(current, entry.name);
        const relative = path.relative(directory, entryPath);

        if (entry.isDirectory()) {
          return walk(entryPath, depth + 1);
        }

        // A link is a leaf: it is never followed here, and `readdir` reports it as itself.
        if (entry.isSymbolicLink() && options.symlinks && depth >= 2) {
          return;
        }

        if (!entry.isFile()) {
          throw unsafe(`${path.basename(directory)}/${relative}: not a plain file or folder`);
        }

        const stats = await limit(() => fs.promises.lstat(entryPath));

        if (stats.nlink > 1) {
          throw unsafe(`${path.basename(directory)}/${relative}: a hard link`);
        }
      }),
    );
  };

  await walk(directory, 1);
}
