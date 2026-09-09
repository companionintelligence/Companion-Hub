import { execAsync } from '@/common/helpers/exec-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';

/**
 * Quote one argument for `/bin/sh`.
 *
 * ⚠ `execAsync` IS `child_process.exec`, WHICH RUNS A SHELL. Every path handed
 * to this service is interpolated into a command string, and a backup filename
 * is caller-supplied: it arrives as `file.originalname` on the upload route and
 * comes back out of `restoreApp`. A name like `` a`id`.tar.gz `` is a perfectly
 * ordinary single path segment — the containment fence in `resolveBackupFilePath`
 * has no reason to reject it — so unquoted interpolation turned "restore the
 * backup I uploaded" into arbitrary command execution as the backend user.
 *
 * Single quotes disable every shell metacharacter; the only character that needs
 * handling is the single quote itself, which closes the run (`'`), contributes an
 * escaped literal quote (`\'`), and reopens (`'`).
 *
 * Exported for its own test: it is the whole of the defence, so it is asserted
 * directly against a real `/bin/sh` rather than only through the commands below.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

@Injectable()
export class ArchiveService {
  constructor(private readonly logger: LoggerService) {}

  createTarGz = async (sourceDir: string, destinationFile: string) => {
    const tarCommand = `tar -czpf ${shellQuote(destinationFile)} -C ${shellQuote(sourceDir)} .`;
    this.logger.debug(`Creating archive with command: ${tarCommand}`);
    return execAsync(tarCommand);
  };

  extractTarGz = async (sourceFile: string, destinationDir: string) => {
    const fileType = await execAsync(`file --brief --mime-type ${shellQuote(sourceFile)}`);
    const mimeType = fileType.stdout.trim();

    let tarCommand = `tar -xzpf ${shellQuote(sourceFile)} -C ${shellQuote(destinationDir)}`;

    if (mimeType === 'application/x-tar') {
      tarCommand = `tar -xpf ${shellQuote(sourceFile)} -C ${shellQuote(destinationDir)}`;
    }

    this.logger.debug(`Extracting archive with command: ${tarCommand}`);
    return await execAsync(tarCommand);
  };
}
