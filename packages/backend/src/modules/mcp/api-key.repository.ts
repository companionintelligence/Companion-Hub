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

/** SEC-MCP-8: data access for the shared `api_key` table. Audience-aware so one table serves every
 *  inbound key surface (MCP today, REST later). Mirrors the port-allocation repository pattern. */
@Injectable()
export class ApiKeyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(row: {
    audience: string;
    name: string;
    prefix: string;
    hashedKey: string;
    managed: boolean;
    ownerAppUrn: string | null;
    expiresAt: string | null;
  }): Promise<ApiKeyRow> {
    const [result] = await this.db.insert(apiKey).values(row).returning().execute();
    return result as ApiKeyRow;
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

  /** Delete by id, scoped to an audience so one surface can't revoke another surface's key by id. */
  async deleteById(id: number, audience: string): Promise<number> {
    const result = await this.db
      .delete(apiKey)
      .where(and(eq(apiKey.id, id), eq(apiKey.audience, audience)))
      .returning()
      .execute();
    return result.length;
  }

  /** Delete an app's managed key(s) within one audience — never touches a different surface's keys. */
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
