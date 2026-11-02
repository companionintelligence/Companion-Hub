import fs from 'node:fs';
import type { DataProgress, DataProgressStep } from '@ci-hub/common/schemas';

export type DataProgressListener = (progress: DataProgress) => void;

/** What a step has done so far, and what it has to do where that is known. */
export type DataProgressSample = { doneBytes: number; totalBytes?: number };

const POLL_INTERVAL_MS = 2000;
/** A measurement that takes this share of the time at most: walking a folder of a million files is not free. */
const POLL_BUSY_FACTOR = 5;
/** How much of each new reading goes into the speed, so one slow disk flush does not swing the figure. */
const RATE_SMOOTHING = 0.3;

/**
 * Run `work`, telling `listener` what it is doing and, every couple of seconds, how far `read` says it
 * has got. A step `read` cannot measure still reports its name, once.
 *
 * Progress is only ever a figure on a page, so nothing about it can fail the work: a `read` that throws
 * or answers `null` means no new figure, and a listener that throws is ignored.
 *
 * @param read `undefined` for a step with no figure to give
 */
export async function withDataProgress<T>(
  listener: DataProgressListener | undefined,
  step: DataProgressStep,
  read: (() => Promise<DataProgressSample | null>) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!listener) return work();

  const tell = (progress: DataProgress) => {
    try {
      listener(progress);
    } catch {
      // Only a figure on a page.
    }
  };

  tell({ step });

  if (!read) return work();

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let last: { doneBytes: number; at: number } | undefined;
  let rate: number | undefined;

  const poll = async () => {
    const startedAt = Date.now();
    const sample = await read().catch(() => null);

    if (stopped) return;

    if (sample) {
      const now = Date.now();
      // A figure past the total is the tar headers the total leaves out, not more work than planned.
      const doneBytes = sample.totalBytes === undefined ? sample.doneBytes : Math.min(sample.doneBytes, sample.totalBytes);

      if (last && now > last.at && doneBytes >= last.doneBytes) {
        const current = ((doneBytes - last.doneBytes) * 1000) / (now - last.at);
        rate = rate === undefined ? current : rate + RATE_SMOOTHING * (current - rate);
      }

      if (!last || doneBytes !== last.doneBytes) {
        tell({
          step,
          doneBytes,
          ...(sample.totalBytes === undefined ? {} : { totalBytes: sample.totalBytes }),
          ...(rate === undefined ? {} : { bytesPerSecond: Math.round(rate) }),
        });
      }

      last = { doneBytes, at: now };
    }

    timer = setTimeout(poll, Math.max(POLL_INTERVAL_MS, (Date.now() - startedAt) * POLL_BUSY_FACTOR));
    timer.unref?.();
  };

  timer = setTimeout(poll, POLL_INTERVAL_MS);
  timer.unref?.();

  try {
    return await work();
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
}

/**
 * The bytes a running process has read so far, from the kernel's own count. A tar that is archiving
 * reads the data itself and hands it on to gzip; one that is unpacking or listing reads what gzip
 * hands it. So either way this counts the uncompressed data, which the size of the archive does not:
 * a folder of text finishes at a fraction of its size, and the figure would stop short of the total.
 *
 * `null` where it cannot be told: the process has ended, or the platform has no `/proc`.
 */
export async function processBytesRead(pid: number | undefined): Promise<number | null> {
  if (pid === undefined) return null;

  const io = await fs.promises.readFile(`/proc/${pid}/io`, 'utf8').catch(() => null);
  const count = io === null ? undefined : /^rchar:\s*(\d+)$/m.exec(io)?.[1];

  return count === undefined ? null : Number(count);
}

/** The size of a file, `null` while it is not there yet. */
export async function fileBytes(file: string): Promise<number | null> {
  return fs.promises.stat(file).then(
    (stat) => stat.size,
    () => null,
  );
}

/**
 * The size of the regular files under `dir`. Links are not followed and what cannot be read counts as
 * nothing, so this is an estimate for a progress figure, never the basis of a decision.
 */
export async function directoryBytes(dir: string, skip?: (entry: string) => boolean): Promise<number> {
  let total = 0;
  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const full = `${current}/${entry.name}`;

      if (skip?.(full)) continue;

      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        total += await fs.promises.lstat(full).then(
          (stat) => stat.size,
          () => 0,
        );
      }
    }
  }

  return total;
}
