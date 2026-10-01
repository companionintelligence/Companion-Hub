import fs from 'node:fs';
import { spawnAsync, type SpawnResult } from '@/common/helpers/exec-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';

export type ArchiveEntry = { path: string; type: string };

const INVALID_ARCHIVE = 'Invalid backup archive';

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
   */
  listTarGz = async (sourceFile: string): Promise<ArchiveEntry[]> => {
    const gzip = await this.isGzip(sourceFile);
    const verboseArgs = [gzip ? '-tzvf' : '-tvf', sourceFile];
    const pathArgs = [gzip ? '-tzf' : '-tf', sourceFile];

    this.logger.debug(`Listing archive with args: tar ${verboseArgs.join(' ')}`);
    const [verboseList, pathList] = await Promise.all([spawnAsync('tar', verboseArgs), spawnAsync('tar', pathArgs)]);

    if (verboseList.exitCode !== 0 || pathList.exitCode !== 0) {
      this.logger.error(`Archive listing failed: ${(verboseList.stderr || pathList.stderr).trim()}`);
      throw new Error(INVALID_ARCHIVE);
    }

    const verboseLines = verboseList.stdout.split('\n').filter(Boolean);
    const paths = pathList.stdout.split('\n').filter(Boolean);

    if (verboseLines.length !== paths.length) {
      throw new Error(INVALID_ARCHIVE);
    }

    return paths.map((entryPath, index) => ({ path: entryPath, type: verboseLines[index]?.[0] ?? '' }));
  };

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
