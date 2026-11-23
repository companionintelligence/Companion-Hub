import fs from 'node:fs';
import path from 'node:path';
import type { DataMove } from '@ci-hub/common/schemas';
import { firstLinkOnTheWay } from '@/modules/docker/bind-mount-guard';

/** The Hub's own files in an app's data folder, which a move from `.` never takes along. */
const HUB_OWNED_ROOT_ENTRIES = new Set(['app.env', 'backups']);

/** A move that would overwrite files, or cannot run at all. Stops the start that asked for it. */
export class AppDataMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppDataMoveError';
  }
}

const segmentsOf = (relative: string) => (relative === '.' ? [] : relative.split('/'));

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  return fs.promises.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return null;
    }
    throw error;
  });
}

async function isEmptyFolder(target: string, stat: fs.Stats): Promise<boolean> {
  return stat.isDirectory() && (await fs.promises.readdir(target)).length === 0;
}

/** Refuses a path whose existing parts run through a symbolic link: a rename would act wherever it points. */
async function assertNoLink(root: string, relative: string, appName: string): Promise<void> {
  const link = await firstLinkOnTheWay(root, segmentsOf(relative));
  if (link !== null) {
    throw new AppDataMoveError(`Can't move the data of "${appName}": "${link}" in its data folder is a symbolic link.`);
  }
}

/**
 * Puts `source` where `destination` is, if it can do so without overwriting anything. An empty folder
 * on either side does not count as data: the Hub makes a version's mount folders ahead of its start,
 * and an old version may leave one behind.
 */
async function moveOne(source: string, destination: string, describe: () => string): Promise<boolean> {
  const sourceStat = await lstatOrNull(source);
  if (!sourceStat) {
    return false;
  }
  const destinationStat = await lstatOrNull(destination);
  if (destinationStat) {
    if (await isEmptyFolder(destination, destinationStat)) {
      await fs.promises.rmdir(destination);
    } else if (await isEmptyFolder(source, sourceStat)) {
      await fs.promises.rmdir(source);
      return false;
    } else {
      throw new AppDataMoveError(`${describe()}: both places hold files. Move or remove one of them, then start the app again.`);
    }
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.promises.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new AppDataMoveError(`${describe()}: the two places are on different disks, which a move here can't cross.`);
    }
    throw error;
  }
  return true;
}

/**
 * Carries out a listing's data moves (`data_moves`, see dataMoveSchema) in the app's data folder, in
 * order. Each moves only what is still in its old place, so running them again does nothing.
 *
 * @param appDataDir the app's data folder, as the Hub sees it
 * @param keepSources the new version's bind-mount sources inside the data folder, relative to it: a
 *   move of a folder's contents leaves what holds one of them where it is
 * @returns what was moved, as `from → to` lines
 */
export async function applyAppDataMoves(params: {
  appName: string;
  appDataDir: string;
  moves: readonly DataMove[];
  keepSources: readonly string[];
}): Promise<string[]> {
  const { appName, appDataDir, moves, keepSources } = params;
  const moved: string[] = [];

  for (const move of moves) {
    await assertNoLink(appDataDir, move.from, appName);
    await assertNoLink(appDataDir, move.to, appName);
    const fromSegments = segmentsOf(move.from);
    const toSegments = segmentsOf(move.to);
    const intoItself = fromSegments.length < toSegments.length && fromSegments.every((segment, index) => toSegments[index] === segment);
    const from = path.join(appDataDir, ...fromSegments);
    const to = path.join(appDataDir, ...toSegments);

    if (!intoItself) {
      if (await moveOne(from, to, () => `Can't move "${move.from}" to "${move.to}" for "${appName}"`)) {
        moved.push(`${move.from} → ${move.to}`);
      }
      continue;
    }

    const fromStat = await lstatOrNull(from);
    if (!fromStat?.isDirectory()) {
      continue;
    }
    // What stays: the first part of `to` below `from`, and of every other mount source below it.
    const keep = new Set<string>([toSegments[fromSegments.length] as string]);
    for (const source of keepSources) {
      const sourceSegments = segmentsOf(source);
      if (sourceSegments.length > fromSegments.length && fromSegments.every((segment, index) => sourceSegments[index] === segment)) {
        keep.add(sourceSegments[fromSegments.length] as string);
      }
    }
    if (fromSegments.length === 0) {
      for (const entry of HUB_OWNED_ROOT_ENTRIES) {
        keep.add(entry);
      }
    }
    const kept = new Set([...keep].map((entry) => entry.toLowerCase()));
    for (const entry of (await fs.promises.readdir(from)).sort()) {
      if (kept.has(entry.toLowerCase())) {
        continue;
      }
      const relative = [...fromSegments, entry].join('/');
      const destination = [...toSegments, entry].join('/');
      if (await moveOne(path.join(from, entry), path.join(to, entry), () => `Can't move "${relative}" into "${move.to}" for "${appName}"`)) {
        moved.push(`${relative} → ${destination}`);
      }
    }
  }
  return moved;
}
