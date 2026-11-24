import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { spawnAsync, spawnLines, type SpawnResult } from '@/common/helpers/exec-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';

export type ArchiveEntry = { path: string; type: string };

const INVALID_ARCHIVE = 'Invalid backup archive';

/**
 * Most entries a listing is trusted to hold. Past this the archive is refused rather than read into
 * memory: a small compressed file can expand to an arbitrary number of entries.
 */
export const MAX_ARCHIVE_ENTRIES = 1_000_000;

/**
 * Every tar invocation here is an argument vector handed straight to the program,
 * never a shell string. A backup filename is caller-supplied (it arrives as
 * `file.originalname` on the upload route and comes back out of `restoreApp`), and
 * `` a`id`.tar.gz `` is an ordinary single path segment, so the only reliable defence
 * is for nothing to re-parse it.
 */
@Injectable()
export class ArchiveService {
  constructor(private readonly logger: LoggerService) {}

  createTarGz = async (sourceDir: string, destinationFile: string) => {
    const args = ['-czpf', destinationFile, '-C', sourceDir, '.'];
    this.logger.debug(`Creating archive with args: tar ${args.join(' ')}`);
    return spawnAsync('tar', args);
  };

  /**
   * Extract `sourceFile` into `destinationDir`. Throws if tar does not exit cleanly.
   *
   * ⚠ A caller that deletes live data after this returns relies on it having thrown.
   * It used to return tar's stderr and let the caller carry on, so a corrupt or
   * non-tar upload "extracted" nothing and the restore wiped the app regardless.
   */
  extractTarGz = async (sourceFile: string, destinationDir: string): Promise<SpawnResult> => {
    const flags = (await this.isGzip(sourceFile)) ? '-xzpf' : '-xpf';
    const args = [flags, sourceFile, '-C', destinationDir];

    this.logger.debug(`Extracting archive with args: tar ${args.join(' ')}`);
    const result = await spawnAsync('tar', args);

    if (result.exitCode !== 0) {
      this.logger.error(`Archive extraction failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      throw new Error(INVALID_ARCHIVE);
    }

    return result;
  };

  /**
   * List an archive's entries WITHOUT extracting it, as `{ path, type }` where `type`
   * is tar's one-character entry kind (`-` file, `d` directory, `l` symlink, `h` hard link, ...).
   *
   * Two listings are taken and zipped: the plain one is the only reliable source of the
   * path, and the verbose one the only source of the type. Splitting the verbose line
   * on whitespace to recover the path breaks on busybox (the timestamp carries seconds,
   * links carry a `->` suffix), which is the tar this image ships.
   *
   * Both are read line by line as tar prints them, keeping a path or one character per entry, so
   * the size of the listing is not limited by a buffer: a photo library of several hundred
   * thousand files lists as readily as a small app.
   */
  listTarGz = async (sourceFile: string): Promise<ArchiveEntry[]> => {
    const gzip = await this.isGzip(sourceFile);
    const verboseArgs = [gzip ? '-tzvf' : '-tvf', sourceFile];
    const pathArgs = [gzip ? '-tzf' : '-tf', sourceFile];

    this.logger.debug(`Listing archive with args: tar ${verboseArgs.join(' ')}`);

    const types: string[] = [];
    const paths: string[] = [];

    const collect = (into: string[], pick: (line: string) => string) => (line: string) => {
      if (!line) return;

      if (into.length >= MAX_ARCHIVE_ENTRIES) {
        throw new Error(`Archive holds more than ${MAX_ARCHIVE_ENTRIES} entries`);
      }

      into.push(pick(line));
    };

    const [verboseList, pathList] = await Promise.all([
      spawnLines(
        'tar',
        verboseArgs,
        collect(types, (line) => line.charAt(0)),
      ),
      spawnLines(
        'tar',
        pathArgs,
        collect(paths, (line) => line),
      ),
    ]);

    if (verboseList.exitCode !== 0 || pathList.exitCode !== 0) {
      this.logger.error(`Archive listing failed: ${(verboseList.stderr || pathList.stderr).trim()}`);
      throw new Error(INVALID_ARCHIVE);
    }

    if (types.length !== paths.length) {
      throw new Error(INVALID_ARCHIVE);
    }

    return paths.map((entryPath, index) => ({ path: entryPath, type: types[index] ?? '' }));
  };

  /**
   * Read an uncompressed tar through to its end without extracting or keeping any of it. Throws when
   * tar cannot, as with a truncated file or one that is not a tar, and for a compressed file: tar
   * undoes compression only in a file it can seek in, and a volume archive is unpacked from a pipe.
   *
   * The archive goes to tar on stdin, not by name. Given a file, busybox seeks over each entry's data,
   * and a seek past the end reads as a clean end of archive, so a file cut short inside an entry passed.
   * Nothing is collected, so unlike {@link listTarGz} there is no limit on the number of entries.
   */
  verifyPlainTar = async (sourceFile: string): Promise<void> => {
    if (!(await this.hasTarMagic(sourceFile))) {
      this.logger.error(`${sourceFile} is not an uncompressed tar archive`);
      throw new Error(INVALID_ARCHIVE);
    }

    this.logger.debug(`Checking archive ${sourceFile} with tar -tf -`);
    const input = await fs.promises.open(sourceFile, 'r');

    try {
      const { exitCode, stderr } = await new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
        const child = spawn('tar', ['-tf', '-'], { stdio: [input.fd, 'ignore', 'pipe'] });
        let stderr = '';

        child.stderr?.on('data', (chunk) => {
          stderr = `${stderr}${chunk}`.slice(-4096);
        });
        child.on('error', (error) => resolve({ exitCode: null, stderr: error.message }));
        child.on('close', (code) => resolve({ exitCode: code, stderr }));
      });

      if (exitCode !== 0) {
        this.logger.error(`Archive check of ${sourceFile} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
        throw new Error(INVALID_ARCHIVE);
      }
    } finally {
      await input.close();
    }
  };

  /** `ustar` at offset 257, where every tar header written today has it and a compressed file does not. */
  private async hasTarMagic(sourceFile: string): Promise<boolean> {
    try {
      const handle = await fs.promises.open(sourceFile, 'r');

      try {
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(5), 0, 5, 257);
        return bytesRead === 5 && buffer.toString('latin1') === 'ustar';
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  /**
   * Gzip magic bytes, not the `file` program: the Hub image does not ship it, so asking
   * `file` returned nothing and every archive was treated as gzip regardless. Anything
   * that is not gzip is handed to tar as a plain archive and fails there if it is neither.
   */
  private async isGzip(sourceFile: string): Promise<boolean> {
    try {
      const handle = await fs.promises.open(sourceFile, 'r');

      try {
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
        return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
      } finally {
        await handle.close();
      }
    } catch {
      return true;
    }
  }
}
