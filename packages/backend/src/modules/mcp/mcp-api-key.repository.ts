import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { mcpApiKey } from '@/core/database/drizzle/schema';

/** A stored MCP API key row. Only the SHA-256 `hashedKey` is persisted — never the raw key. */
export interface McpApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  hashedKey: string;
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** SEC-MCP-8: data access for the `mcp_api_key` table. Mirrors the port-allocation repository pattern
 *  (constructor-injected DATABASE, drizzle query builder). */
@Injectable()
export class McpApiKeyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(row: {
    name: string;
    prefix: string;
    hashedKey: string;
    managed: boolean;
    ownerAppUrn: string | null;
    expiresAt: string | null;
  }): Promise<McpApiKeyRow> {
    const [result] = await this.db.insert(mcpApiKey).values(row).returning().execute();
    return result as McpApiKeyRow;
  }

  async findByHash(hashedKey: string): Promise<McpApiKeyRow | undefined> {
    return this.db.query.mcpApiKey.findFirst({ where: eq(mcpApiKey.hashedKey, hashedKey) }) as Promise<McpApiKeyRow | undefined>;
  }

  async findManagedByOwner(ownerAppUrn: string): Promise<McpApiKeyRow[]> {
    return this.db.query.mcpApiKey.findMany({ where: eq(mcpApiKey.ownerAppUrn, ownerAppUrn) }) as Promise<McpApiKeyRow[]>;
  }

  async list(): Promise<McpApiKeyRow[]> {
    return this.db.query.mcpApiKey.findMany({ orderBy: [desc(mcpApiKey.createdAt)] }) as Promise<McpApiKeyRow[]>;
  }

  async count(): Promise<number> {
    const rows = await this.db.query.mcpApiKey.findMany({ columns: { id: true } });
    return rows.length;
  }

  async deleteById(id: number): Promise<number> {
    const result = await this.db.delete(mcpApiKey).where(eq(mcpApiKey.id, id)).returning().execute();
    return result.length;
  }

  async deleteByOwnerAppUrn(ownerAppUrn: string): Promise<number> {
    const result = await this.db.delete(mcpApiKey).where(eq(mcpApiKey.ownerAppUrn, ownerAppUrn)).returning().execute();
    return result.length;
  }

  async touchLastUsed(id: number, whenIso: string): Promise<void> {
    await this.db.update(mcpApiKey).set({ lastUsedAt: whenIso }).where(eq(mcpApiKey.id, id)).execute();
  }
}
