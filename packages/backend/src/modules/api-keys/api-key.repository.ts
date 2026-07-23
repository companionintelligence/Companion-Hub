import { Inject, Injectable } from '@nestjs/common';
import { count, desc, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { apiKey } from '@/core/database/drizzle/schema';
import type { ApiKeyScope } from './api-key.scopes';

/** A stored API key row. Only the SHA-256 `hashedKey` is persisted — never the raw key. */
export interface ApiKeyRow {
  id: number;
  /** Transitional dual-write of `scopes[0]` kept for one release so a rolled-back Hub still works. */
  audience: string;
  scopes: string[];
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

/**
 * Data access for the shared `api_key` table (SEC-MCP-8 lineage). One table serves every inbound
 * key surface; which surfaces accept a key is expressed by its `scopes` array, checked by
 * {@link ApiKeyService} after a hash lookup. The legacy single-valued `audience` column is still
 * dual-written (as `scopes[0]`) purely for rollback safety and is dropped in a follow-up release.
 */
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

  /**
   * Look up a key by hash alone. Which surfaces the key opens is a property of the row (`scopes`),
   * not of the lookup — the service enforces scope membership after resolution, so a key minted for
   * one surface still can't authenticate another.
   */
  async findByHash(hashedKey: string): Promise<ApiKeyRow | undefined> {
    return this.db.query.apiKey.findFirst({
      where: eq(apiKey.hashedKey, hashedKey),
    }) as Promise<ApiKeyRow | undefined>;
  }

  /** All keys, newest first — the hub-wide admin listing. */
  async list(): Promise<ApiKeyRow[]> {
    return this.db.query.apiKey.findMany({
      orderBy: [desc(apiKey.createdAt)],
    }) as Promise<ApiKeyRow[]>;
  }

  async countAll(): Promise<number> {
    const [res] = await this.db.select({ count: count() }).from(apiKey);
    return res?.count ?? 0;
  }

  /** Count keys carrying a scope. Rows are few (an appliance holds a handful of keys), so this
   *  filters in memory rather than depending on array-operator support in the query layer. */
  async countByScope(scope: ApiKeyScope): Promise<number> {
    const rows = await this.list();
    return rows.filter((row) => row.scopes.includes(scope)).length;
  }

  async deleteById(id: number): Promise<number> {
    const result = await this.db.delete(apiKey).where(eq(apiKey.id, id)).returning().execute();
    return result.length;
  }

  async deleteByOwnerAppUrn(ownerAppUrn: string): Promise<number> {
    const result = await this.db.delete(apiKey).where(eq(apiKey.ownerAppUrn, ownerAppUrn)).returning().execute();
    return result.length;
  }

  /** Rewrite a key's scopes in place (same secret). `audience` is dual-written alongside. */
  async updateScopes(id: number, scopes: string[], audience: string): Promise<void> {
    await this.db.update(apiKey).set({ scopes, audience }).where(eq(apiKey.id, id)).execute();
  }

  async touchLastUsed(id: number, whenIso: string): Promise<void> {
    await this.db.update(apiKey).set({ lastUsedAt: whenIso }).where(eq(apiKey.id, id)).execute();
  }
}
