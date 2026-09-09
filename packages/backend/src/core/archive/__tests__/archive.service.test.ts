import { execFileSync } from 'node:child_process';
import { mock } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';

const { execAsyncMock } = vi.hoisted(() => ({ execAsyncMock: vi.fn() }));

vi.mock('@/common/helpers/exec-helpers', () => ({ execAsync: execAsyncMock }));

const { ArchiveService, shellQuote } = await import('../archive.service');

/*
 * ⚠ THESE ARE ALL LEGAL SINGLE PATH SEGMENTS. That is the point: a backup
 * filename is caller-supplied (`file.originalname` on upload, echoed back into
 * `restoreApp`), and `resolveBackupFilePath` fences it to one segment inside the
 * app's own directory — which every name here satisfies. Nothing upstream has a
 * reason to reject them, so the quoting here is the only thing standing between
 * a filename and `/bin/sh`.
 */
const HOSTILE_NAMES = [
  'a`id`.tar.gz',
  'a$(id).tar.gz',
  'a;rm -rf /.tar.gz',
  'a b && whoami.tar.gz',
  "o'brien.tar.gz",
  "a'$(id)'.tar.gz",
  'a|tee /tmp/pwned.tar.gz',
  'a>out<in.tar.gz',
  'a\\b.tar.gz',
  'a"b.tar.gz',
  'a\nnewline.tar.gz',
  'a~$HOME.tar.gz',
  'ordinary-backup.tar.gz',
];

describe('shellQuote', () => {
  /*
   * The assertion that matters is not the shape of the quoted string but what a
   * real shell does with it: the argument must come back out byte-for-byte, and
   * nothing inside it may execute. `printf %s` is the smallest program that can
   * report exactly one argument without adding anything of its own.
   */
  it.each(HOSTILE_NAMES)('passes %j through /bin/sh as one literal argument', (name) => {
    const stdout = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(name)}`]).toString();

    expect(stdout).toBe(name);
  });

  it('does not execute a substitution that would otherwise run', () => {
    // Unquoted, `$(echo pwned)` is replaced by the shell before printf ever sees it.
    const stdout = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote('$(echo pwned)')}`]).toString();

    expect(stdout).toBe('$(echo pwned)');
    expect(stdout).not.toContain('pwned\n');
  });

  /*
   * A glob only proves anything where it MATCHES: `printf %s a*.tar.gz` in a
   * directory with no such file leaves the pattern alone, so that assertion would
   * pass with or without quoting. Run it at `/`, where `*` always matches — the
   * spawned shell reads the real filesystem, not this suite's `fs` mock.
   */
  it('does not let a glob expand against real files on disk', () => {
    const stdout = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${shellQuote('*')}`], { cwd: '/' }).toString();

    expect(stdout).toBe('*\n');
    expect(stdout).not.toContain('etc');
  });

  it('quotes an empty string into something the shell still counts as an argument', () => {
    // Unquoted, an empty path vanishes from argv entirely and the next word slides
    // into its place — `tar -czpf  -C /src .` reads `-C` as the archive name.
    const argv = execFileSync('/bin/sh', ['-c', `count() { printf '%s' "$#"; }; count ${shellQuote('')} after`]).toString();

    expect(argv).toBe('2');
  });
});

describe('ArchiveService', () => {
  let service: InstanceType<typeof ArchiveService>;

  beforeEach(() => {
    execAsyncMock.mockReset();
    execAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
    service = new ArchiveService(mock<LoggerService>());
  });

  it('quotes both paths handed to tar when creating an archive', async () => {
    await service.createTarGz('/tmp/src dir', "/tmp/a'b.tar.gz");

    expect(execAsyncMock).toHaveBeenCalledWith(`tar -czpf '/tmp/a'\\''b.tar.gz' -C '/tmp/src dir' .`);
  });

  it('quotes the source path handed to `file` before probing the mime type', async () => {
    await service.extractTarGz('/tmp/a`id`.tar.gz', '/tmp/dest');

    expect(execAsyncMock).toHaveBeenNthCalledWith(1, "file --brief --mime-type '/tmp/a`id`.tar.gz'");
  });

  it('quotes both paths handed to tar when extracting a gzipped archive', async () => {
    await service.extractTarGz('/tmp/a;rm -rf /.tar.gz', '/tmp/dest dir');

    expect(execAsyncMock).toHaveBeenNthCalledWith(2, `tar -xzpf '/tmp/a;rm -rf /.tar.gz' -C '/tmp/dest dir'`);
  });

  it('quotes both paths on the uncompressed-tar branch too', async () => {
    // The branch `file` selects must be fenced identically; it was the same sink.
    execAsyncMock.mockResolvedValueOnce({ stdout: 'application/x-tar\n', stderr: '' });

    await service.extractTarGz('/tmp/a$(id).tar', '/tmp/dest');

    expect(execAsyncMock).toHaveBeenNthCalledWith(2, `tar -xpf '/tmp/a$(id).tar' -C '/tmp/dest'`);
  });

  /*
   * The end-to-end property, without a real tar: take the command the service
   * actually built and let a shell parse it, with `tar` replaced by a stub that
   * reports its argv. A traversal or an injection shows up as extra words.
   */
  it('builds a command a shell parses into exactly the intended argv', async () => {
    await service.createTarGz('/tmp/src', 'a`id`.tar.gz');

    const command = execAsyncMock.mock.calls[0]?.[0] as string;
    const argv = execFileSync('/bin/sh', ['-c', `tar() { printf '%s\\n' "$@"; }; ${command}`])
      .toString()
      .trimEnd()
      .split('\n');

    expect(argv).toEqual(['-czpf', 'a`id`.tar.gz', '-C', '/tmp/src', '.']);
  });
});
