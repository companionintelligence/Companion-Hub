import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { federatedIdentity, user, userDirectory } from '@/core/database/drizzle/schema';
import type { LoggerService } from '@/core/logger/logger.service';
import { ForwardAuthIdentityResolver } from '@/modules/auth/forward-auth-identity.resolver';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
import { type TestDatabase, createTestDatabase } from '../utils/create-test-database';

// The shared test setup mocks `fs`; the migration under test is the real file on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

const PORTAL = 'https://hub.ci.computer';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * Against the real database and the real migrations: that every person gets a public id of their
 * own and keeps it through a rename, that the directory is one row the resolver names as
 * `urn:ci-hub:<uuid>`, and that the Portal Bearer path finds the Hub person a subject is bound to,
 * unless that person was revoked.
 */
describe('forward auth: who a Hub person is, for good', () => {
  let db: TestDatabase;
  let users: UserRepository;
  let sessionUserCache: SessionUserCache;
  let federatedIdentities: FederatedIdentityRepository;

  const resolver = () => new ForwardAuthIdentityResolver(db as never, users, federatedIdentities, sessionUserCache, mock<LoggerService>());

  const insertUser = async (username: string) => {
    const [row] = await db.insert(user).values({ username, password: 'not-a-real-hash' }).returning();
    return row;
  };

  beforeAll(async () => {
    db = await createTestDatabase('forwardauthidentitytest');
  });

  beforeEach(async () => {
    await db.delete(federatedIdentity);
    await db.delete(user);
    sessionUserCache = new SessionUserCache();
    users = new UserRepository(db as never, sessionUserCache);
    federatedIdentities = new FederatedIdentityRepository(db as never);
  });

  it('gives each person a public id of their own, unchanged by a rename', async () => {
    const alice = await insertUser('alice@example.com');
    const bob = await insertUser('bob@example.com');

    expect(alice.publicId).toMatch(UUID);
    expect(bob.publicId).not.toBe(alice.publicId);

    await users.updateUser(alice.id, { username: 'alice.renamed@example.com' });

    expect(await users.getPublicId(alice.id)).toBe(alice.publicId);
  });

  it('gives every EXISTING row its own id as the column is added, not one shared default', async () => {
    // Replays migration 0066's statement against rows that predate it.
    const migration = readFileSync(path.join(__dirname, '../../core/database/drizzle/0066_user_public_id_and_directory.sql'), 'utf-8');
    const addColumn = migration.split('--> statement-breakpoint')[0].trim();
    expect(addColumn).toMatch(/ADD COLUMN IF NOT EXISTS "public_id"/);

    await db.execute(sql`DROP INDEX IF EXISTS "user_public_id_idx"`);
    await db.execute(sql`ALTER TABLE "user" DROP COLUMN "public_id"`);
    try {
      await db.execute(
        sql`INSERT INTO "user" ("username", "password") VALUES ('a@example.com', 'x'), ('b@example.com', 'x'), ('c@example.com', 'x')`,
      );
      await db.execute(sql.raw(addColumn));

      const rows = await db.execute<{ public_id: string }>(sql`SELECT "public_id" FROM "user"`);
      const ids = rows.rows.map((row) => row.public_id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    } finally {
      await db.execute(sql`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "public_id" uuid DEFAULT gen_random_uuid() NOT NULL`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "user_public_id_idx" ON "user" USING btree ("public_id")`);
    }
  });

  it('keeps one directory row, refusing a second', async () => {
    const rows = await db.select().from(userDirectory);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('self');

    await expect(db.insert(userDirectory).values({ id: 'other' })).rejects.toThrow();
  });

  it("signs a person's public id under this Hub's directory", async () => {
    const alice = await insertUser('alice@example.com');
    const [directory] = await db.select().from(userDirectory).where(eq(userDirectory.id, 'self'));

    await expect(resolver().stableIdFor(alice.id)).resolves.toEqual({
      issuer: `urn:ci-hub:${directory.directoryId}`,
      userId: alice.publicId,
    });
  });

  it('names nobody by id for a user that does not exist', async () => {
    await expect(resolver().stableIdFor(999_999)).resolves.toBeNull();
  });

  it('finds the Hub person a Portal subject is bound to, by their username today', async () => {
    const owner = await insertUser('owner@example.com');
    await federatedIdentities.create({ userId: owner.id, issuer: PORTAL, subject: 'portal-sub', email: 'owner@example.com' });
    await users.updateUser(owner.id, { username: 'owner.renamed@example.com' });

    await expect(resolver().personForPortalSubject(PORTAL, 'portal-sub')).resolves.toEqual({
      username: 'owner.renamed@example.com',
      stableId: { issuer: expect.stringMatching(/^urn:ci-hub:/), userId: owner.publicId },
    });
  });

  it('finds nobody for an unbound subject, or for a revoked person', async () => {
    const revoked = await insertUser('revoked@example.com');
    await federatedIdentities.create({ userId: revoked.id, issuer: PORTAL, subject: 'revoked-sub' });
    await users.updateUser(revoked.id, { accessStatus: 'revoked' });

    const identities = resolver();
    await expect(identities.personForPortalSubject(PORTAL, 'nobody-sub')).resolves.toBeNull();
    await expect(identities.personForPortalSubject(PORTAL, 'revoked-sub')).resolves.toBeNull();
  });
});
