import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiKey, user } from '@/core/database/drizzle/schema';
import { ApiKeyRepository } from '@/modules/api-keys/api-key.repository';
import { type TestDatabase, createTestDatabase } from '../utils/create-test-database';

/*
 * Against the real database and the real migrations: that `created_by_user_id`
 * exists after `migrate`, that the admin listing's join names who created each
 * key, and that deleting that account leaves the key with no creator rather
 * than failing, or taking the key with it.
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

  const insertKey = (name: string, createdByUserId: number | null) =>
    repo.insert({
      scopes: ['mcp'],
      capability: 'write',
      name,
      prefix: name.slice(0, 8),
      hashedKey: `hash-${name}`,
      managed: false,
      ownerAppUrn: null,
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

  it('keeps the key, with no creator, when the account that created it is deleted', async () => {
    const member = await insertUser('member@acme.com');
    const key = await insertKey('agent', member.id);

    await db.delete(user).where(eq(user.id, member.id));

    expect(await repo.findById(key.id)).toMatchObject({ createdByUserId: null });
  });
});
