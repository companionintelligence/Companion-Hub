import fs from 'node:fs';
import path from 'node:path';
import { pLimit } from '@/common/helpers/file-helpers';
import type { ArchiveEntry } from '@/core/archive/archive.service';

/**
 * What a restore will accept from a backup archive.
 *
 * A backup is produced by this system (`BackupManager.backupApp`) as exactly three
 * top-level folders of plain files and directories, but a restore also takes archives
 * a user UPLOADED, so nothing about the archive is trusted. Every rule here is checked
 * before any live app file is touched; a restore deletes the app's existing data first,
 * so the order — validate, then replace — is the whole point.
 */

/** The folders a backup archive may contain. Anything else at the top level is not ours. */
export const BACKUP_ROOT_FOLDERS = ['app-data', 'app', 'user-config'] as const;

/** One message for every rejected shape: the caller is told the backup is unusable, not how to tailor the next attempt. */
export const UNSAFE_BACKUP_MESSAGE = 'Backup contains unsupported file types';

const MISSING_FOLDER_MESSAGE = 'Backup is missing required folders';

const unsafe = () => new Error(UNSAFE_BACKUP_MESSAGE);

/**
 * Reject an archive listing that could escape the extraction directory or smuggle a
 * non-file into it, without extracting anything.
 *
 * Only regular files (`-`) and directories (`d`) are allowed. Symbolic links, hard links,
 * devices and FIFOs are all refused: a link planted in `user-config/` is followed by the
 * next read or write of that file, and one in `app-data/` is followed by whatever the
 * Hub later does with the folder (browse it, fix its permissions).
 */
export function validateRestoreArchiveEntries(entries: ArchiveEntry[]): void {
  for (const entry of entries) {
    if (entry.type !== '-' && entry.type !== 'd') {
      throw unsafe();
    }

    const entryPath = normalizeArchiveEntryPath(entry.path);

    if (entryPath === '.') {
      continue;
    }

    const rootFolder = entryPath.split('/')[0];

    if (!rootFolder || !(BACKUP_ROOT_FOLDERS as readonly string[]).includes(rootFolder)) {
      throw unsafe();
    }
  }
}

function normalizeArchiveEntryPath(entryPath: string): string {
  if (entryPath.includes('\0') || path.posix.isAbsolute(entryPath)) {
    throw unsafe();
  }

  const normalized = path.posix.normalize(entryPath.replace(/^(\.\/)+/, ''));

  if (normalized === '..' || normalized.startsWith('../')) {
    throw unsafe();
  }

  return normalized;
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
export async function validateRestoreDirectory(directory: string, options: { required: boolean }): Promise<void> {
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
    throw unsafe();
  }

  // The recursion itself is not rate-limited, only the filesystem calls inside it: a
  // limited task that awaited limited children would deadlock once the parents filled
  // every slot.
  const walk = async (current: string): Promise<void> => {
    const entries = await limit(() => fs.promises.readdir(current, { withFileTypes: true }));

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(current, entry.name);

        if (entry.isDirectory()) {
          return walk(entryPath);
        }

        if (!entry.isFile()) {
          throw unsafe();
        }

        const stats = await limit(() => fs.promises.lstat(entryPath));

        if (stats.nlink > 1) {
          throw unsafe();
        }
      }),
    );
  };

  await walk(directory);
}
