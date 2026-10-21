import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `node:fs/promises`, which the module writes with, is the real one: only `fs` is swapped for memfs.
const dataDir = await vi.hoisted(async () => {
  const [{ tmpdir }, { join }] = await Promise.all([import('node:os'), import('node:path')]);
  return join(tmpdir(), `restore-notice-${process.pid}-${Date.now()}`);
});

vi.mock('@/common/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/constants')>()),
  DATA_DIR: dataDir,
}));

const { acknowledgeRestoreNotice, clearRegistrationRecoveryArtifacts, clearRehydrationState, readRestoreNotice, startRestoreNotice } = await import(
  '../registration-recovery-state'
);

describe('restore notice', () => {
  const noticeFile = path.join(dataDir, 'state', 'restore-notice.json');

  beforeEach(async () => {
    await fs.rm(path.join(dataDir, 'state'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('records when the restore began and keeps the first start', async () => {
    await startRestoreNotice();
    const first = await readRestoreNotice();
    await startRestoreNotice();

    expect(first?.startedAt).toEqual(expect.any(String));
    await expect(readRestoreNotice()).resolves.toEqual(first);
  });

  it('keeps a notice the restore page acknowledged before the restore began', async () => {
    await acknowledgeRestoreNotice();
    await startRestoreNotice();

    const notice = await readRestoreNotice();
    expect(notice?.acknowledgedAt).toEqual(expect.any(String));
    expect(notice?.startedAt).toBeUndefined();
  });

  it('keeps when the restore began once it has been seen', async () => {
    await startRestoreNotice();
    const { startedAt } = (await readRestoreNotice()) ?? {};
    await acknowledgeRestoreNotice();

    await expect(readRestoreNotice()).resolves.toEqual({ startedAt, acknowledgedAt: expect.any(String) });
  });

  it('goes with the rehydration state, which a new pairing or a reset clears', async () => {
    await startRestoreNotice();
    await clearRehydrationState();
    await expect(readRestoreNotice()).resolves.toBeNull();

    await startRestoreNotice();
    await clearRegistrationRecoveryArtifacts();
    await expect(readRestoreNotice()).resolves.toBeNull();
  });

  it('reads a damaged notice as none, so it cannot hold every sign-in on the restore page', async () => {
    await fs.mkdir(path.dirname(noticeFile), { recursive: true });
    await fs.writeFile(noticeFile, '{not json', 'utf-8');

    await expect(readRestoreNotice()).resolves.toBeNull();
  });
});
