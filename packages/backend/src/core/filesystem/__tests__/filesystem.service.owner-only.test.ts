import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';

// The real file system: the memfs mock the suite installs keeps no permission bits to check.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('../filesystem.service');

// Windows keeps no owner-only mode to read back, so the mode checks below cannot say anything there.
describe.skipIf(process.platform === 'win32')('FilesystemService.restrictToOwner', () => {
  let scratch: string;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let service: InstanceType<typeof FilesystemService>;

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fs-owner-only-'));
    logger = mock<LoggerService>();
    service = new FilesystemService(logger);
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('takes a file other accounts can read down to owner-only, and reports that it did', async () => {
    const archive = path.join(scratch, 'backup.tar.gz');
    await fs.promises.writeFile(archive, 'archive');
    await fs.promises.chmod(archive, 0o644);

    await expect(service.restrictToOwner(archive)).resolves.toBe(true);

    expect((await fs.promises.stat(archive)).mode & 0o777).toBe(0o600);
  });

  it('reports a file it cannot restrict, and logs it, rather than reporting success', async () => {
    await expect(service.restrictToOwner(path.join(scratch, 'missing.tar.gz'))).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error restricting'), expect.anything());
  });
});
