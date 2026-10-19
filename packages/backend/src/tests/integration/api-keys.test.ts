import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { CacheService } from '@/core/cache/cache.service';
import type { SessionUserCache } from '@/core/cache/session-user.cache';
import { apiKey, user } from '@/core/database/drizzle/schema';
import { ApiKeyRepository } from '@/modules/api-keys/api-key.repository';
import { FactoryResetService } from '@/modules/system/factory-reset.service';
import { type TestDatabase, createTestDatabase } from '../utils/create-test-database';

/*
 * Against the real database and the real migrations: that `created_by_user_id`
 * exists after `migrate`, that the admin listing's join names who created each
 * key, that deleting an account deletes the keys it created and no one else's,
 * and that a factory reset takes every key.
 */
describe('API keys and who created them', () => {
  let db: TestDatabase;
  let repo: ApiKeyRepository;

  beforeAll(async () => {
    db = await createTestDatabase('apikeycreatortest');
    repo = new ApiKeyRepository(db as never);
  });

  beforeEach(async () => {
    await db.delete(apiKey);
    await db.delete(user);
  });

  const insertKey = (name: string, createdByUserId: number | null, managedFor?: string) =>
    repo.insert({
      scopes: ['mcp'],
      capability: 'write',
      name,
      prefix: name.slice(0, 8),
      hashedKey: `hash-${name}`,
      managed: managedFor !== undefined,
      ownerAppUrn: managedFor ?? null,
      createdByUserId,
      expiresAt: null,
    });

  const insertUser = async (username: string) => {
    const [row] = await db.insert(user).values({ username, password: 'not-a-real-hash' }).returning();

    return row;
  };

  it('lists each key with the username of the person who created it', async () => {
    const owner = await insertUser('owner@acme.com');
    await insertKey('n8n', owner.id);
    await insertKey('legacy', null);

    const listed = await repo.list();

    expect(listed.find((row) => row.name === 'n8n')).toMatchObject({ createdByUserId: owner.id, createdByUsername: 'owner@acme.com' });
    expect(listed.find((row) => row.name === 'legacy')).toMatchObject({ createdByUserId: null, createdByUsername: null });
  });

  /*
   * A key acts with its creator's grants. Left behind with no creator, it would
   * keep the per-app reach of a key made before creators were recorded, so the
   * account's deletion would widen its keys instead of retiring them.
   */
  it("deletes an account's keys with it, and leaves everyone else's", async () => {
    const member = await insertUser('member@acme.com');
    const owner = await insertUser('owner@acme.com');
    const memberKey = await insertKey('agent', member.id);
    const ownerKey = await insertKey('n8n', owner.id);
    const legacyKey = await insertKey('legacy', null);

    await db.delete(user).where(eq(user.id, member.id));

    expect(await repo.findById(memberKey.id)).toBeUndefined();
    expect(await repo.findById(ownerKey.id)).toMatchObject({ createdByUserId: owner.id });
    expect(await repo.findById(legacyKey.id)).toMatchObject({ createdByUserId: null });
  });

  /*
   * A revoked person's own keys go with them (#2062). Managed app keys and
   * everyone else's keys stay.
   */
  it("deletes a person's unmanaged keys and leaves managed and other people's keys", async () => {
    const leaver = await insertUser('leaver@acme.com');
    const owner = await insertUser('owner@acme.com');
    const leaverKey = await insertKey('agent', leaver.id);
    const leaverManaged = await insertKey('importer', leaver.id, 'importer:ci-store');
    const ownerKey = await insertKey('n8n', owner.id);

    await expect(repo.deleteUnmanagedByCreator(leaver.id)).resolves.toBe(1);

    expect(await repo.findById(leaverKey.id)).toBeUndefined();
    expect(await repo.findById(leaverManaged.id)).toBeDefined();
    expect(await repo.findById(ownerKey.id)).toBeDefined();
  });

  it('deletes the unmanaged keys of everyone revoked as their rows stand now', async () => {
    const revoked = await insertUser('revoked@acme.com');
    const readmitted = await insertUser('back@acme.com');
    await db.update(user).set({ accessStatus: 'revoked' }).where(eq(user.id, revoked.id));
    const revokedKey = await insertKey('agent', revoked.id);
    const revokedManaged = await insertKey('importer', revoked.id, 'importer:ci-store');
    const readmittedKey = await insertKey('n8n', readmitted.id);
    const legacyKey = await insertKey('legacy', null);

    await expect(repo.deleteUnmanagedOfRevokedCreators()).resolves.toBe(1);

    expect(await repo.findById(revokedKey.id)).toBeUndefined();
    expect(await repo.findById(revokedManaged.id)).toBeDefined();
    expect(await repo.findById(readmittedKey.id)).toBeDefined();
    expect(await repo.findById(legacyKey.id)).toBeDefined();
  });

  /*
   * `RESTART IDENTITY` hands the next account the ids the reset freed, so a key
   * that survived would act as whoever signs in first. Every kind goes: one a
   * person created, one nobody is recorded as creating, and an app's managed key.
   */
  it('leaves no key behind after a factory reset, whoever created it', async () => {
    const owner = await insertUser('owner@acme.com');
    await insertKey('n8n', owner.id);
    await insertKey('legacy', null);
    await insertKey('importer', null, 'importer:ci-store');

    const factoryReset = new FactoryResetService(
      db as never,
      mock(),
      mock(),
      mock(),
      mock(),
      mock<CacheService>(),
      mock<SessionUserCache>(),
      mock(),
      mock(),
    );
    await factoryReset.wipeDatabase();

    expect(await repo.list()).toEqual([]);
  });
});
