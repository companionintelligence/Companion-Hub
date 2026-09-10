import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import { beforeEach, vi } from 'vitest';
import type { FsMock } from './__mocks__/fs';

vi.mock('fs', async () => {
  const { fsMock } = await import('./__mocks__/fs');
  return {
    // Default-import consumers (`import fs from 'node:fs'`) read fs.readFileSync etc. off this.
    ...fsMock,
    // Named-import consumers (`import { readFileSync } from 'node:fs'`) need the same methods
    // at the top level too — vitest's module mock has no other way to serve both import styles
    // from one factory. Without this, a named import finds no such export and throws, even
    // though the (unrelated) default-import call sites work fine.
    ...fsMock.default,
  };
});

vi.mock('node:sqlite', () => {
  const sqlite = require('node:sqlite');
  return sqlite;
});

vi.mock('@/utils/cooldown/cooldown', () => ({
  Cooldown: () => vi.fn().mockImplementation((fn) => fn),
}));

beforeEach(async () => {
  (fs as unknown as FsMock).__resetAllMocks();

  const directories = [DATA_DIR, path.join(DATA_DIR, 'state'), path.join(DATA_DIR, 'backups')];

  try {
    await Promise.all(
      directories.map(async (dir) => {
        await fs.promises.mkdir(dir, { recursive: true });
      }),
    );

    await fs.promises.writeFile(path.join(DATA_DIR, 'state', 'seed'), 'seed');
    await fs.promises.writeFile(path.join(DATA_DIR, '.env'), 'ROOT_FOLDER_HOST=/opt/ci-hub');
  } catch (err) {
    console.error('Failed to setup test directories', err);
  }
});
