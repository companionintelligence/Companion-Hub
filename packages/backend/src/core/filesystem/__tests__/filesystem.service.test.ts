import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '../filesystem.service';

describe('FilesystemService.createTempDirectory', () => {
  // `fs` is globally mocked onto memfs (see src/tests/vite.setup.ts) — the OS temp dir
  // path isn't pre-seeded there, so it must exist in the virtual volume before mkdtemp
  // can create anything under it.
  beforeEach(async () => {
    await fs.promises.mkdir(os.tmpdir(), { recursive: true });
  });

  it('roots a non-absolute prefix under the OS temp dir instead of process.cwd()', async () => {
    const service = new FilesystemService(mock<LoggerService>());

    // A real app URN, e.g. "ci-memory:ci-marketplace" — `fs.mkdtemp` would otherwise
    // resolve this relative to process.cwd(), which is an unwritable `/app` in the Hub
    // container and throws EACCES.
    const prefix = 'ci-memory:ci-marketplace';
    const dir = await service.createTempDirectory(prefix);
    expect(dir).not.toBeNull();

    expect(path.isAbsolute(dir as string)).toBe(true);
    expect(path.dirname(dir as string)).toBe(os.tmpdir());
    expect(path.basename(dir as string).startsWith(prefix)).toBe(true);
  });
});
