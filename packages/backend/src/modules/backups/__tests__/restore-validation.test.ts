import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real symlinks and hard links: the memfs mock the suite installs cannot represent either.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { readVolumeArchiveKeys, validateRestoreArchiveEntries, validateRestoreDirectory, UNSAFE_BACKUP_MESSAGE } = await import(
  '../restore-validation'
);

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

  it.each(['.env', 'etc/passwd', 'app-data-evil/x', 'apps/x', 'user-config.bak/x', 'volumes.tar'])(
    'rejects the top-level name %j, which is not a backup folder',
    (entryPath) => {
      expect(() => validateRestoreArchiveEntries([file(entryPath)])).toThrow(UNSAFE_BACKUP_MESSAGE);
    },
  );

  it("accepts the app's named Docker volumes, one tar archive each", () => {
    expect(() =>
      validateRestoreArchiveEntries([
        dir('./'),
        dir('./app-data/'),
        dir('./app/'),
        dir('./volumes/'),
        file('./volumes/data-mariadb.tar'),
        file('./volumes/db_2.tar'),
      ]),
    ).not.toThrow();
  });

  it.each([
    ['a folder', dir('./volumes/data-mariadb/')],
    ['a file inside a folder', file('./volumes/sub/data-mariadb.tar')],
    ['a name that does not end in .tar', file('./volumes/data-mariadb.tar.gz')],
    ['a name no Docker volume can have', file('./volumes/.data.tar')],
    ['a symbolic link', { path: './volumes/data-mariadb.tar', type: 'l' }],
    ['a hard link', { path: './volumes/data-mariadb.tar', type: 'h' }],
  ])('rejects %s in the volumes folder', (_name, entry) => {
    expect(() => validateRestoreArchiveEntries([dir('./app-data/'), dir('./app/'), dir('./volumes/'), entry])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects an entry that is only reached through a folder it climbs out of', () => {
    // Normalises to `evil`, not `app-data/...`: the allowlist must see the normalised path.
    expect(() => validateRestoreArchiveEntries([file('app-data/../evil')])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('allows the archive root itself', () => {
    expect(() => validateRestoreArchiveEntries([dir('./'), dir('.')])).not.toThrow();
  });
});

describe('validateRestoreArchiveEntries: symbolic links', () => {
  const link = (p: string) => ({ path: p, type: 'l' });
  const layout = [dir('./app-data/'), dir('./app-data/data/'), dir('./app/'), dir('./user-config/')];

  it('accepts a link inside the app data folder, below its top level', () => {
    expect(() => validateRestoreArchiveEntries([...layout, file('./app-data/data/real'), link('./app-data/data/alias')])).not.toThrow();
  });

  it.each([
    ['at the top of app-data, where the Hub writes app.env', './app-data/app.env'],
    ['in the installed app files', './app/docker-compose.json'],
    ['deep in the installed app files', './app/sub/dir/link'],
    ['in user-config', './user-config/app.env'],
  ])('rejects a link %s', (_name, entryPath) => {
    expect(() => validateRestoreArchiveEntries([...layout, link(entryPath)])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects an entry placed through a link that comes before it', () => {
    expect(() => validateRestoreArchiveEntries([...layout, link('./app-data/data/hole'), file('./app-data/data/hole/pwned')])).toThrow(
      UNSAFE_BACKUP_MESSAGE,
    );
  });

  it('rejects an entry placed through a link that comes after it', () => {
    expect(() => validateRestoreArchiveEntries([...layout, file('./app-data/data/hole/pwned'), link('./app-data/data/hole')])).toThrow(
      UNSAFE_BACKUP_MESSAGE,
    );
  });

  it('rejects a folder that has the same path as a link, which would be made over it', () => {
    expect(() => validateRestoreArchiveEntries([...layout, link('./app-data/data/x'), dir('./app-data/data/x/')])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('rejects a link placed through another link', () => {
    expect(() => validateRestoreArchiveEntries([...layout, link('./app-data/data/a'), link('./app-data/data/a/b')])).toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('does not mistake a sibling whose name starts like a link for something placed through it', () => {
    expect(() =>
      validateRestoreArchiveEntries([...layout, link('./app-data/data/lib'), file('./app-data/data/lib64'), file('./app-data/data/lib.txt')]),
    ).not.toThrow();
  });

  it('names the entry and the rule in the error, for the log', () => {
    try {
      validateRestoreArchiveEntries([...layout, link('./user-config/leak')]);
      expect.unreachable();
    } catch (error) {
      expect((error as { detail?: string }).detail).toContain('user-config/leak');
      expect((error as Error).message).toBe(UNSAFE_BACKUP_MESSAGE);
    }
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

  describe('with symlinks allowed (the app data folder)', () => {
    it('accepts a link below the top level, relative or absolute, dangling or not', async () => {
      await write('data/real.txt');
      await fs.promises.symlink('real.txt', path.join(root, 'data', 'alias'));
      await fs.promises.symlink('/usr/bin/python3', path.join(root, 'data', 'python'));
      await fs.promises.symlink('missing', path.join(root, 'data', 'dangling'));

      await expect(validateRestoreDirectory(root, { required: true, symlinks: true })).resolves.toBeUndefined();
    });

    it('still rejects a link at the top level, where the Hub keeps its own files', async () => {
      await fs.promises.symlink('/etc/passwd', path.join(root, 'app.env'));

      await expect(validateRestoreDirectory(root, { required: true, symlinks: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
    });

    it('does not follow a link into the folder it points at', async () => {
      const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restore-validation-outside-'));
      await fs.promises.writeFile(path.join(outside, 'twin.txt'), 'x');
      await fs.promises.link(path.join(outside, 'twin.txt'), path.join(outside, 'twin2.txt'));
      await fs.promises.mkdir(path.join(root, 'data'));
      await fs.promises.symlink(outside, path.join(root, 'data', 'out'));

      try {
        await expect(validateRestoreDirectory(root, { required: true, symlinks: true })).resolves.toBeUndefined();
      } finally {
        await fs.promises.rm(outside, { recursive: true, force: true });
      }
    });

    it('still rejects a hard link', async () => {
      await write('data/original.txt');
      await fs.promises.link(path.join(root, 'data', 'original.txt'), path.join(root, 'data', 'twin.txt'));

      await expect(validateRestoreDirectory(root, { required: true, symlinks: true })).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
    });
  });
});

describe('readVolumeArchiveKeys', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restore-volumes-'));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('reads each volume key from its <key>.tar file', async () => {
    await fs.promises.writeFile(path.join(root, 'data-mariadb.tar'), 'x');
    await fs.promises.writeFile(path.join(root, 'db_2.tar'), 'x');

    await expect(readVolumeArchiveKeys(root).then((keys) => keys.sort())).resolves.toEqual(['data-mariadb', 'db_2']);
  });

  it('finds none in a backup without a volumes folder', async () => {
    await expect(readVolumeArchiveKeys(path.join(root, 'volumes'))).resolves.toEqual([]);
  });

  it('refuses an empty archive, which would empty the volume and put nothing back', async () => {
    await fs.promises.writeFile(path.join(root, 'data-mariadb.tar'), '');

    await expect(readVolumeArchiveKeys(root)).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });

  it('refuses a folder in place of an archive', async () => {
    await fs.promises.mkdir(path.join(root, 'data-mariadb.tar'));

    await expect(readVolumeArchiveKeys(root)).rejects.toThrow(UNSAFE_BACKUP_MESSAGE);
  });
});
