import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
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
    const rows = await this.db.query.apiKey.findMany({ where: eq(apiKey.audience, audience), columns: { id: true } });
    return rows.length;
  }

  async deleteById(id: number): Promise<number> {
    const result = await this.db.delete(apiKey).where(eq(apiKey.id, id)).returning().execute();
    return result.length;
  }

  async deleteByOwnerAppUrn(ownerAppUrn: string): Promise<number> {
    const result = await this.db.delete(apiKey).where(eq(apiKey.ownerAppUrn, ownerAppUrn)).returning().execute();
    return result.length;
  }

  async touchLastUsed(id: number, whenIso: string): Promise<void> {
    await this.db.update(apiKey).set({ lastUsedAt: whenIso }).where(eq(apiKey.id, id)).execute();
  }
}
