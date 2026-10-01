import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';

vi.unmock('node:fs');
vi.unmock('fs');

const realFs = await import('node:fs');

const { spawnAsyncMock, spawnLinesMock } = vi.hoisted(() => ({ spawnAsyncMock: vi.fn(), spawnLinesMock: vi.fn() }));

vi.mock('@/common/helpers/exec-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/exec-helpers')>()),
  spawnAsync: spawnAsyncMock,
  spawnLines: spawnLinesMock,
}));

const { ArchiveService, MAX_ARCHIVE_ENTRIES } = await import('../archive.service');

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

/*
 * ⚠ THESE ARE ALL LEGAL SINGLE PATH SEGMENTS. That is the point: a backup
 * filename is caller-supplied (`file.originalname` on upload, echoed back into
 * `restoreApp`), and `resolveBackupFilePath` fences it to one segment inside the
 * app's own directory — which every name here satisfies. Nothing upstream has a
 * reason to reject them, so the only defence is that no shell ever sees them.
 */
const HOSTILE_NAMES = [
  'a`id`.tar.gz',
  'a$(id).tar.gz',
  'a;rm -rf /.tar.gz',
  'a b && whoami.tar.gz',
  "o'brien.tar.gz",
  'a|tee /tmp/pwned.tar.gz',
  'a>out<in.tar.gz',
  'a"b.tar.gz',
  'ordinary-backup.tar.gz',
];

describe('ArchiveService (argument vectors)', () => {
  let service: InstanceType<typeof ArchiveService>;
  let scratch: string;
  let gzipFile: string;
  let tarFile: string;

  beforeAll(async () => {
    scratch = await realFs.promises.mkdtemp(path.join(os.tmpdir(), 'archive-service-'));
    gzipFile = path.join(scratch, 'gzip.tar.gz');
    tarFile = path.join(scratch, 'plain.tar');
    await realFs.promises.writeFile(gzipFile, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    await realFs.promises.writeFile(tarFile, Buffer.concat([Buffer.alloc(257), Buffer.from('ustar')]));
  });

  afterAll(async () => {
    await realFs.promises.rm(scratch, { recursive: true, force: true });
  });

  beforeEach(() => {
    spawnAsyncMock.mockReset();
    spawnLinesMock.mockReset();
    spawnAsyncMock.mockResolvedValue(ok());
    service = new ArchiveService(mock<LoggerService>());
  });

  it.each(HOSTILE_NAMES)('creates an archive named %j as one literal argument', async (name) => {
    await service.createTarGz('/tmp/src dir', name);

    expect(spawnAsyncMock).toHaveBeenCalledWith('tar', ['-czpf', name, '-C', '/tmp/src dir', '.']);
  });

  it('extracts a gzip archive with the gzip flag', async () => {
    await service.extractTarGz(gzipFile, '/tmp/dest dir');

    expect(spawnAsyncMock).toHaveBeenCalledWith('tar', ['-xzpf', gzipFile, '-C', '/tmp/dest dir']);
  });

  it('extracts a plain tar without the gzip flag', async () => {
    await service.extractTarGz(tarFile, '/tmp/dest');

    expect(spawnAsyncMock).toHaveBeenCalledWith('tar', ['-xpf', tarFile, '-C', '/tmp/dest']);
  });

  it('throws when tar does not exit cleanly, so a caller never proceeds on a failed extraction', async () => {
    spawnAsyncMock.mockResolvedValue({ stdout: '', stderr: 'tar: Unexpected EOF in archive', exitCode: 2 });

    await expect(service.extractTarGz(gzipFile, '/tmp/dest')).rejects.toThrow('Invalid backup archive');
  });

  it('throws when tar could not be started at all', async () => {
    spawnAsyncMock.mockResolvedValue({ stdout: '', stderr: 'spawn tar ENOENT', exitCode: null });

    await expect(service.extractTarGz(gzipFile, '/tmp/dest')).rejects.toThrow('Invalid backup archive');
  });

  describe('listTarGz', () => {
    // busybox `tar -tv`: seconds in the timestamp, a `->` suffix on links. Splitting this on
    // whitespace to recover the path is what the two-listing approach exists to avoid.
    const BUSYBOX_VERBOSE = [
      'drwxr-xr-x 0/0               0 2026-09-01 10:00:00 ./',
      'drwxr-xr-x 0/0               0 2026-09-01 10:00:00 app-data/',
      '-rw-r--r-- 0/0              12 2026-09-01 10:00:00 app-data/my file.txt',
      'lrwxrwxrwx 0/0               0 2026-09-01 10:00:00 app-data/link -> /etc/passwd',
    ].join('\n');
    const BUSYBOX_PATHS = ['./', 'app-data/', 'app-data/my file.txt', 'app-data/link'].join('\n');

    /** Feed each canned listing to the callback the way `spawnLines` would, line by line. */
    const mockListings = (verbose: string, paths: string, result: { exitCode: number | null; stderr: string } = { exitCode: 0, stderr: '' }) =>
      spawnLinesMock.mockImplementation(async (_cmd: string, args: string[], onLine: (line: string) => void) => {
        try {
          for (const line of (args[0]?.includes('v') ? verbose : paths).split('\n')) onLine(line);
        } catch (error) {
          return { exitCode: null, stderr: '', error: error as Error };
        }

        return result;
      });

    it('pairs each path with its entry type from the verbose listing', async () => {
      mockListings(BUSYBOX_VERBOSE, BUSYBOX_PATHS);

      await expect(service.listTarGz(gzipFile)).resolves.toEqual([
        { path: './', type: 'd' },
        { path: 'app-data/', type: 'd' },
        { path: 'app-data/my file.txt', type: '-' },
        { path: 'app-data/link', type: 'l' },
      ]);
    });

    it('lists a gzip archive with the gzip flags and a plain one without', async () => {
      mockListings('', '');

      await service.listTarGz(gzipFile);
      expect(spawnLinesMock).toHaveBeenCalledWith('tar', ['-tzvf', gzipFile], expect.any(Function));
      expect(spawnLinesMock).toHaveBeenCalledWith('tar', ['-tzf', gzipFile], expect.any(Function));

      spawnLinesMock.mockClear();
      mockListings('', '');

      await service.listTarGz(tarFile);
      expect(spawnLinesMock).toHaveBeenCalledWith('tar', ['-tvf', tarFile], expect.any(Function));
      expect(spawnLinesMock).toHaveBeenCalledWith('tar', ['-tf', tarFile], expect.any(Function));
    });

    it('rejects a listing tar failed to produce', async () => {
      mockListings('', '', { exitCode: 2, stderr: 'tar: not in gzip format' });

      await expect(service.listTarGz(gzipFile)).rejects.toThrow('Invalid backup archive');
    });

    it('rejects an archive with more entries than it will hold in memory', async () => {
      const many = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => `app-data/${i}`).join('\n');
      mockListings(many.replace(/^/gm, '-'), many);

      await expect(service.listTarGz(gzipFile)).rejects.toThrow('Invalid backup archive');
    });

    it('skips the blank lines a trailing newline leaves', async () => {
      mockListings('-rw-r--r-- 0/0 1 2026-09-01 10:00:00 a.txt\n', 'a.txt\n');

      await expect(service.listTarGz(gzipFile)).resolves.toEqual([{ path: 'a.txt', type: '-' }]);
    });

    it('rejects listings whose lengths disagree rather than guess which line is which', async () => {
      mockListings(BUSYBOX_VERBOSE, './\napp-data/');

      await expect(service.listTarGz(gzipFile)).rejects.toThrow('Invalid backup archive');
    });
  });
});

const hasTar = (() => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// The real thing: an actual tar binary over an actual archive, so what is asserted is what
// the host's tar prints and what it extracts, not what a fixture says it prints.
describe.skipIf(!hasTar)('ArchiveService (real tar)', () => {
  vi.doUnmock('@/common/helpers/exec-helpers');

  let scratch: string;

  beforeAll(async () => {
    scratch = await realFs.promises.mkdtemp(path.join(os.tmpdir(), 'archive-service-real-'));
  });

  afterAll(async () => {
    await realFs.promises.rm(scratch, { recursive: true, force: true });
  });

  const realService = async () => {
    const actual = await vi.importActual<typeof import('@/common/helpers/exec-helpers')>('@/common/helpers/exec-helpers');
    spawnAsyncMock.mockImplementation(actual.spawnAsync);
    spawnLinesMock.mockImplementation(actual.spawnLines);

    return new ArchiveService(mock<LoggerService>());
  };

  it('round-trips a directory, listing files and directories as - and d', async () => {
    const service = await realService();
    const source = path.join(scratch, 'source');
    await realFs.promises.mkdir(path.join(source, 'app-data'), { recursive: true });
    await realFs.promises.writeFile(path.join(source, 'app-data', 'note with spaces.txt'), 'hello');
    const archive = path.join(scratch, 'out.tar.gz');

    const created = await service.createTarGz(source, archive);
    expect(created.exitCode).toBe(0);

    const entries = await service.listTarGz(archive);
    expect(entries.find((e) => e.path.endsWith('note with spaces.txt'))?.type).toBe('-');
    expect(entries.find((e) => e.path.replace(/\/$/, '').endsWith('app-data'))?.type).toBe('d');

    const dest = path.join(scratch, 'dest');
    await realFs.promises.mkdir(dest);
    await service.extractTarGz(archive, dest);
    await expect(realFs.promises.readFile(path.join(dest, 'app-data', 'note with spaces.txt'), 'utf8')).resolves.toBe('hello');
  });

  it('reports a symlink entry as l without extracting it', async () => {
    const service = await realService();
    const source = path.join(scratch, 'with-link');
    await realFs.promises.mkdir(source, { recursive: true });
    await realFs.promises.symlink('/etc/passwd', path.join(source, 'evil'));
    const archive = path.join(scratch, 'link.tar.gz');
    await service.createTarGz(source, archive);

    const entries = await service.listTarGz(archive);

    expect(entries.find((e) => e.path.endsWith('evil'))?.type).toBe('l');
  });

  it('refuses a file that is not a tar archive', async () => {
    const service = await realService();
    const bogus = path.join(scratch, 'bogus.tar.gz');
    await realFs.promises.writeFile(bogus, 'this is not an archive');

    await expect(service.listTarGz(bogus)).rejects.toThrow('Invalid backup archive');
    await expect(service.extractTarGz(bogus, scratch)).rejects.toThrow('Invalid backup archive');
  });

  it('refuses a truncated gzip stream', async () => {
    const service = await realService();
    const source = path.join(scratch, 'trunc-src');
    await realFs.promises.mkdir(source, { recursive: true });
    await realFs.promises.writeFile(path.join(source, 'big.bin'), Buffer.alloc(256 * 1024, 7));
    const archive = path.join(scratch, 'trunc.tar.gz');
    await service.createTarGz(source, archive);
    const bytes = await realFs.promises.readFile(archive);
    await realFs.promises.writeFile(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));

    await expect(service.listTarGz(archive)).rejects.toThrow('Invalid backup archive');
  });

  it('lists an archive of over a thousand long-named files end to end', async () => {
    const service = await realService();
    const source = path.join(scratch, 'many');
    await realFs.promises.mkdir(path.join(source, 'app-data'), { recursive: true });
    // The size property itself (more output than spawnAsync's cap) is covered against spawnLines directly.
    const long = 'n'.repeat(120);
    await Promise.all(Array.from({ length: 1500 }, (_, i) => realFs.promises.writeFile(path.join(source, 'app-data', `${long}-${i}`), '')));
    const archive = path.join(scratch, 'many.tar.gz');
    await service.createTarGz(source, archive);

    const entries = await service.listTarGz(archive);

    expect(entries.filter((entry) => entry.type === '-')).toHaveLength(1500);
  }, 30_000);
});
