import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { memoryConnection } from '@/core/database/drizzle/schema';

/** Persisted connection state for a memory-consumer app. */
export type MemoryConnectionState = 'unconfigured' | 'connected' | 'skipped' | 'manual';

/** A stored memory-connection row. `encryptedKey` is ciphertext (never the raw key). */
export interface MemoryConnectionRow {
  id: number;
  appUrn: string;
  hubUserId: number;
  state: MemoryConnectionState;
  encryptedKey: string | null;
  serverUrl: string | null;
  keyExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Install-global sentinel for pre-family-auth rows and operator-manual credentials. */
export const INSTALL_GLOBAL_HUB_USER_ID = 0;

/**
 * Data access for the `memory_connection` table. One row per (app URN, Hub
 * person), holding the connection state and — when connected — the encrypted
 * CI-Server key plus the resolved memory URL.
 */
@Injectable()
export class MemoryConnectionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Latest row for an app (any user), or undefined if the app was never touched. */
  async findByAppUrn(appUrn: string): Promise<MemoryConnectionRow | undefined> {
    return this.db.query.memoryConnection.findFirst({
      where: eq(memoryConnection.appUrn, appUrn),
      orderBy: [desc(memoryConnection.updatedAt)],
    }) as Promise<MemoryConnectionRow | undefined>;
  }

  /** Row for this app and Hub person, or undefined. */
  async findByAppUrnAndUser(appUrn: string, hubUserId: number): Promise<MemoryConnectionRow | undefined> {
    return this.db.query.memoryConnection.findFirst({
      where: and(eq(memoryConnection.appUrn, appUrn), eq(memoryConnection.hubUserId, hubUserId)),
    }) as Promise<MemoryConnectionRow | undefined>;
  }

  /**
   * All apps currently in the `connected` state that hold a stored key — the
   * set the rotation sweep considers. `updatedAt` on each row is when the
   * current key was last stored (connect or rotate), i.e. the key's age.
   */
  async findAllConnected(): Promise<MemoryConnectionRow[]> {
    return this.db.query.memoryConnection.findMany({
      where: and(eq(memoryConnection.state, 'connected'), isNotNull(memoryConnection.encryptedKey)),
    }) as Promise<MemoryConnectionRow[]>;
  }

  /**
   * Insert or update the row for an (app, Hub person). Only the provided fields
   * are written; `updatedAt` is always bumped.
   */
  async upsert(
    appUrn: string,
    values: Partial<Pick<MemoryConnectionRow, 'state' | 'encryptedKey' | 'serverUrl' | 'keyExpiresAt'>>,
    hubUserId: number = INSTALL_GLOBAL_HUB_USER_ID,
  ): Promise<MemoryConnectionRow> {
    const now = new Date().toISOString();
    const [result] = await this.db
      .insert(memoryConnection)
      .values({ appUrn, hubUserId, ...values, updatedAt: now })
      .onConflictDoUpdate({
        target: [memoryConnection.appUrn, memoryConnection.hubUserId],
        set: { ...values, updatedAt: now },
      })
      .returning()
      .execute();

    return result as MemoryConnectionRow;
  }

  /** Delete every row for an app (used when the app is uninstalled). */
  async deleteByAppUrn(appUrn: string): Promise<number> {
    const result = await this.db.delete(memoryConnection).where(eq(memoryConnection.appUrn, appUrn)).execute();

    return result.rowCount ?? 0;
  }
}
