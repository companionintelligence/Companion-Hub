import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { apiKey } from '@/core/database/drizzle/schema';

/** A stored API key row. Only the SHA-256 `hashedKey` is persisted — never the raw key. */
export interface ApiKeyRow {
  id: number;
  audience: string;
  name: string;
  prefix: string;
  hashedKey: string;
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Insertable columns (id/lastUsedAt/createdAt are DB-generated). */
export type NewApiKeyRow = Omit<ApiKeyRow, 'id' | 'lastUsedAt' | 'createdAt'>;

/** SEC-MCP-8: data access for the shared `api_key` table. Audience-aware so one table serves every
 *  inbound key surface (MCP today, REST later): every lookup and delete is scoped by audience, so
 *  one surface can never read or revoke another surface's keys. Mirrors the port-allocation
 *  repository pattern. */
@Injectable()
export class ApiKeyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(row: NewApiKeyRow): Promise<ApiKeyRow> {
    const [result] = await this.db.insert(apiKey).values(row).returning().execute();
    return result as ApiKeyRow;
  }

  /** Insert unless the (audience, hashedKey) pair already exists — returns undefined when it does.
   *  Makes bootstrap seeding idempotent under a double-start race (both would insert the same
   *  derived key; the loser's plain insert would violate the unique index and kill its boot). */
  async insertIfHashAbsent(row: NewApiKeyRow): Promise<ApiKeyRow | undefined> {
    const [result] = await this.db.insert(apiKey).values(row).onConflictDoNothing().returning().execute();
    return result as ApiKeyRow | undefined;
  }

  /** Look up by hash AND audience so a key minted for one surface can't authenticate another. */
  async findByHash(hashedKey: string, audience: string): Promise<ApiKeyRow | undefined> {
    return this.db.query.apiKey.findFirst({
      where: and(eq(apiKey.hashedKey, hashedKey), eq(apiKey.audience, audience)),
    }) as Promise<ApiKeyRow | undefined>;
  }

  async listByAudience(audience: string): Promise<ApiKeyRow[]> {
    return this.db.query.apiKey.findMany({
      where: eq(apiKey.audience, audience),
      orderBy: [desc(apiKey.createdAt)],
    }) as Promise<ApiKeyRow[]>;
  }

  async countByAudience(audience: string): Promise<number> {
    const [res] = await this.db.select({ count: count() }).from(apiKey).where(eq(apiKey.audience, audience));
    return res?.count ?? 0;
  }

  async deleteById(id: number, audience: string): Promise<number> {
    const result = await this.db
      .delete(apiKey)
      .where(and(eq(apiKey.id, id), eq(apiKey.audience, audience)))
      .returning()
      .execute();
    return result.length;
  }

  async deleteByOwnerAppUrn(ownerAppUrn: string, audience: string): Promise<number> {
    const result = await this.db
      .delete(apiKey)
      .where(and(eq(apiKey.ownerAppUrn, ownerAppUrn), eq(apiKey.audience, audience)))
      .returning()
      .execute();
    return result.length;
  }

  async touchLastUsed(id: number, whenIso: string): Promise<void> {
    await this.db.update(apiKey).set({ lastUsedAt: whenIso }).where(eq(apiKey.id, id)).execute();
  }
}
