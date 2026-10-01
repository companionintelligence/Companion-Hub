import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real symlinks and hard links: the memfs mock the suite installs cannot represent either.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { validateRestoreArchiveEntries, validateRestoreDirectory, UNSAFE_BACKUP_MESSAGE } = await import('../restore-validation');

const file = (p: string) => ({ path: p, type: '-' });
const dir = (p: string) => ({ path: p, type: 'd' });

describe('validateRestoreArchiveEntries', () => {
  it('accepts the layout a backup is written with', () => {
    expect(() =>
      validateRestoreArchiveEntries([
        dir('./'),
        dir('./app-data/'),
        file('./app-data/db/data.sqlite'),
        dir('./app/'),
        file('./app/docker-compose.json'),
        dir('./user-config/'),
        file('./user-config/app.env'),
      ]),
    ).not.toThrow();
  });

  it('accepts entries listed without the leading ./', () => {
    expect(() => validateRestoreArchiveEntries([dir('app-data/'), file('app-data/a.txt'), dir('app/')])).not.toThrow();
  });

  it.each([
    ['symbolic link', 'l'],
    ['hard link', 'h'],
    ['character device', 'c'],
    ['block device', 'b'],
    ['fifo', 'p'],
    ['an unreadable type', ''],
  ])('rejects a %s entry', (_name, type) => {
    expect(() => validateRestoreArchiveEntries([{ path: './app-data/x', type }])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it.each([
    ['a parent-directory escape', '../outside.txt'],
    ['a nested parent-directory escape', 'app-data/../../outside.txt'],
    ['a ./-prefixed parent-directory escape', './../outside.txt'],
    ['a bare ..', '..'],
    ['an absolute path', '/etc/cron.d/job'],
    ['a NUL byte', 'app-data/a\0.txt'],
  ])('rejects %s', (_name, entryPath) => {
    expect(() => validateRestoreArchiveEntries([file(entryPath)])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it.each(['.env', 'etc/passwd', 'app-data-evil/x', 'apps/x', 'user-config.bak/x'])(
    'rejects the top-level name %j, which is not one of the three backup folders',
    (entryPath) => {
      expect(() => validateRestoreArchiveEntries([file(entryPath)])).toThrow(UNSAFE_BACKUP_MESSAGE);
    },
  );

  it('rejects an entry that is only reached through a folder it climbs out of', () => {
    // Normalises to `evil`, not `app-data/...`: the allowlist must see the normalised path.
    expect(() => validateRestoreArchiveEntries([file('app-data/../evil')])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('allows the archive root itself', () => {
    expect(() => validateRestoreArchiveEntries([dir('./'), dir('.')])).not.toThrow();
  });
});

describe('validateRestoreDirectory', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restore-validation-'));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content = 'x') => {
    const target = path.join(root, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
  };

  it('accepts a tree of plain files and directories', async () => {
    await write('a/b/c.txt');
    await write('top.txt');

    await expect(validateRestoreDirectory(root, { required: true })).resolves.toBeUndefined();
  });

  it('accepts an empty folder', async () => {
    await expect(validateRestoreDirectory(root, { required: true })).resolves.toBeUndefined();
  });

  it('rejects a symlink at the top of the folder', async () => {
    await fs.promises.symlink('/etc/passwd', path.join(root, 'link'));

    await expect(validateRestoreDirectory(root, { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects a symlink buried several folders down', async () => {
    await write('a/b/c/file.txt');
    await fs.promises.symlink('../../../..', path.join(root, 'a', 'b', 'c', 'up'));

    await expect(validateRestoreDirectory(root, { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects a symlink whose target stays inside the folder: links are refused outright, not judged by where they point', async () => {
    await write('real.txt');
    await fs.promises.symlink('real.txt', path.join(root, 'alias'));

    await expect(validateRestoreDirectory(root, { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects a dangling symlink', async () => {
    await fs.promises.symlink('/nonexistent/target', path.join(root, 'dangling'));

    await expect(validateRestoreDirectory(root, { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects a hard link, which no archive listing can be trusted to flag', async () => {
    await write('original.txt');
    await fs.promises.link(path.join(root, 'original.txt'), path.join(root, 'twin.txt'));

    await expect(validateRestoreDirectory(root, { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects a FIFO', async () => {
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('mkfifo', [path.join(root, 'pipe')]);
    } catch {
      return; // no mkfifo on this host
    }

    await expect(validateRestoreDirectory(root, { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects a root that is itself a symlink to a directory', async () => {
    const target = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restore-validation-target-'));
    const link = path.join(root, 'root-link');
    await fs.promises.symlink(target, link);

    try {
      await expect(validateRestoreDirectory(link, { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
    } finally {
      await fs.promises.rm(target, { recursive: true, force: true });
    }
  });

  it('rejects a root that is a regular file', async () => {
    await write('not-a-dir');

    await expect(validateRestoreDirectory(path.join(root, 'not-a-dir'), { required: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('refuses a missing folder when it is required, so a backup without its data never reaches the delete step', async () => {
    await expect(validateRestoreDirectory(path.join(root, 'app-data'), { required: true })).rejects.toThrow('Backup is missing required folders');
  });

  it('passes a missing folder when it is optional', async () => {
    await expect(validateRestoreDirectory(path.join(root, 'user-config'), { required: false })).resolves.toBeUndefined();
  });

  it('walks a wide, deep tree without deadlocking on its own concurrency limit', async () => {
    for (let i = 0; i < 40; i++) {
      await write(`d${i}/e${i % 5}/f.txt`);
    }

    await expect(validateRestoreDirectory(root, { required: true })).resolves.toBeUndefined();
  });
});
