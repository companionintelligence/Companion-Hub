import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataProgress } from '@ci-hub/common/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { compressorBytesRead, directoryBytes, fileBytes, firstChildPid, processBytesRead, withDataProgress } from '../data-progress';

vi.unmock('node:fs');
vi.unmock('fs');

describe('withDataProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const finishing = () => {
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    return { work: () => work, finish: (value: string) => finish(value) };
  };

  it('runs the work and measures nothing when nobody is listening', async () => {
    const read = vi.fn();

    await expect(withDataProgress(undefined, 'archiving', read, async () => 'done')).resolves.toBe('done');
    expect(read).not.toHaveBeenCalled();
  });

  it('names the step at once, then reports the figures, the total and the speed', async () => {
    const seen: DataProgress[] = [];
    const { work, finish } = finishing();
    const figures = [100_000_000, 200_000_000];
    const running = withDataProgress(
      (progress) => seen.push(progress),
      'archiving',
      async () => ({ doneBytes: figures.shift() ?? 200_000_000, totalBytes: 1_000_000_000 }),
      work,
    );

    expect(seen).toEqual([{ step: 'archiving' }]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(seen[1]).toEqual({ step: 'archiving', doneBytes: 100_000_000, totalBytes: 1_000_000_000 });

    await vi.advanceTimersByTimeAsync(2000);
    expect(seen[2]).toEqual({ step: 'archiving', doneBytes: 200_000_000, totalBytes: 1_000_000_000, bytesPerSecond: 50_000_000 });

    finish('done');
    await expect(running).resolves.toBe('done');
  });

  it('says nothing new while the figure stands still, and stops with the work', async () => {
    const seen: DataProgress[] = [];
    const { work, finish } = finishing();
    const read = vi.fn(async () => ({ doneBytes: 5 }));
    const running = withDataProgress((progress) => seen.push(progress), 'archiving', read, work);

    await vi.advanceTimersByTimeAsync(6000);
    expect(seen).toHaveLength(2);

    finish('done');
    await running;
    const reads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(read).toHaveBeenCalledTimes(reads);
  });

  it('keeps a figure from passing the total: tar counts the headers the total leaves out', async () => {
    const seen: DataProgress[] = [];
    const { work, finish } = finishing();
    const running = withDataProgress(
      (progress) => seen.push(progress),
      'unpacking_backup',
      async () => ({ doneBytes: 150, totalBytes: 100 }),
      work,
    );

    await vi.advanceTimersByTimeAsync(2000);
    expect(seen[1]).toMatchObject({ doneBytes: 100, totalBytes: 100 });

    finish('done');
    await running;
  });

  it('never lets a measurement or a listener fail the work', async () => {
    const { work, finish } = finishing();
    const running = withDataProgress(
      () => {
        throw new Error('page gone');
      },
      'archiving',
      async () => {
        throw new Error('no /proc');
      },
      work,
    );

    await vi.advanceTimersByTimeAsync(4000);
    finish('done');
    await expect(running).resolves.toBe('done');
  });

  it("passes on the work's own failure", async () => {
    await expect(
      withDataProgress(
        () => undefined,
        'archiving',
        undefined,
        async () => {
          throw new Error('disk full');
        },
      ),
    ).rejects.toThrow('disk full');
  });
});

describe('measuring', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-progress-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds up the files under a folder, without following links or entering what is skipped', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.writeFileSync(path.join(dir, 'a'), 'x'.repeat(10));
    fs.writeFileSync(path.join(dir, 'sub', 'b'), 'x'.repeat(5));
    fs.writeFileSync(path.join(dir, 'backups', 'c'), 'x'.repeat(100));
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'link'));

    await expect(directoryBytes(dir, (entry) => path.basename(entry) === 'backups')).resolves.toBe(15);
  });

  it('counts a folder that is not there as nothing', async () => {
    await expect(directoryBytes(path.join(dir, 'missing'))).resolves.toBe(0);
  });

  it('gives the size of a file, and null before it exists', async () => {
    fs.writeFileSync(path.join(dir, 'a'), 'abc');

    await expect(fileBytes(path.join(dir, 'a'))).resolves.toBe(3);
    await expect(fileBytes(path.join(dir, 'missing'))).resolves.toBeNull();
  });

  it("reads a process's count, and null for one that is not running", async () => {
    await expect(processBytesRead(undefined)).resolves.toBeNull();
    await expect(processBytesRead(2 ** 30)).resolves.toBeNull();

    if (fs.existsSync('/proc/self/io')) {
      await expect(processBytesRead(process.pid)).resolves.toEqual(expect.any(Number));
    }
  });

  // A `tar -z`'s gzip is its child: the count followed for an archive is the child's, not tar's.
  it.runIf(fs.existsSync('/proc/self/io'))("finds a process's child and reads the child's count", async () => {
    const parent = spawn('sh', ['-c', 'sleep 5 & wait'], { stdio: 'ignore' });

    try {
      let child: number | null = null;
      for (let tries = 0; tries < 50 && child === null; tries += 1) {
        child = await firstChildPid(parent.pid as number);
        if (child === null) await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(child).toEqual(expect.any(Number));
      expect(child).not.toBe(parent.pid);

      const found: { pid?: number } = {};
      await expect(compressorBytesRead(parent.pid, found)).resolves.toEqual(expect.any(Number));
      expect(found.pid).toBe(child);
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it('has no count for a process with no child yet, or none at all', async () => {
    await expect(compressorBytesRead(undefined)).resolves.toBeNull();
    await expect(compressorBytesRead(2 ** 30)).resolves.toBeNull();
  });
});
