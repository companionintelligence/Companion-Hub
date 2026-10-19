import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('FilesystemService.createFileIfMissing', () => {
  const dir = path.join(os.tmpdir(), 'create-file-if-missing');

  beforeEach(async () => {
    await fs.promises.mkdir(dir, { recursive: true });
  });

  it('creates the file once and then reports it exists without rewriting it', async () => {
    const service = new FilesystemService(mock<LoggerService>());
    const file = path.join(dir, 'nested', 'store.json');

    expect(await service.createFileIfMissing(file, '{}', 0o600)).toBe('created');
    await fs.promises.writeFile(file, '{"kept":true}');
    expect(await service.createFileIfMissing(file, '{}', 0o600)).toBe('exists');
    expect(await fs.promises.readFile(file, 'utf8')).toBe('{"kept":true}');
  });

  it('fails, not exists, when the parent path is a file', async () => {
    const service = new FilesystemService(mock<LoggerService>());
    const parent = path.join(dir, 'parent-is-a-file');
    await fs.promises.writeFile(parent, 'not a directory');
    // What Node's recursive mkdir does here (memfs resolves instead): EEXIST, about the parent.
    const mkdir = vi
      .spyOn(fs.promises, 'mkdir')
      .mockRejectedValueOnce(Object.assign(new Error(`EEXIST: file already exists, mkdir '${parent}'`), { code: 'EEXIST' }));

    try {
      expect(await service.createFileIfMissing(path.join(parent, 'store.json'), '{}', 0o600)).toBe('failed');
    } finally {
      mkdir.mockRestore();
    }
  });
});
