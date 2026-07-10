import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { memoryConnection } from '@/core/database/drizzle/schema';

/** Persisted connection state for a memory-consumer app. */
export type MemoryConnectionState = 'unconfigured' | 'connected' | 'skipped' | 'manual';

/** A stored memory-connection row. `encryptedKey` is ciphertext (never the raw key). */
export interface MemoryConnectionRow {
  id: number;
  appUrn: string;
  state: MemoryConnectionState;
  encryptedKey: string | null;
  serverUrl: string | null;
  keyExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Data access for the `memory_connection` table. One row per memory-consumer
 * app (keyed by URN), holding the connection state and — when connected — the
 * encrypted CI-Server key plus the resolved memory URL. Mirrors the
 * audience-scoped repository style used by {@link ApiKeyRepository}.
 */
@Injectable()
export class MemoryConnectionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Fetch the row for an app, or undefined if the app was never touched. */
  async findByAppUrn(appUrn: string): Promise<MemoryConnectionRow | undefined> {
    return this.db.query.memoryConnection.findFirst({
      where: eq(memoryConnection.appUrn, appUrn),
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
   * Insert or update the row for an app (upsert on the unique `app_urn`).
   * Only the provided fields are written; `updatedAt` is always bumped.
   */
  async upsert(
    appUrn: string,
    values: Partial<Pick<MemoryConnectionRow, 'state' | 'encryptedKey' | 'serverUrl' | 'keyExpiresAt'>>,
  ): Promise<MemoryConnectionRow> {
    const now = new Date().toISOString();
    const [result] = await this.db
      .insert(memoryConnection)
      .values({ appUrn, ...values, updatedAt: now })
      .onConflictDoUpdate({
        target: memoryConnection.appUrn,
        set: { ...values, updatedAt: now },
      })
      .returning()
      .execute();

    return result as MemoryConnectionRow;
  }

  /** Delete the row for an app (used when the app is uninstalled). */
  async deleteByAppUrn(appUrn: string): Promise<number> {
    const result = await this.db.delete(memoryConnection).where(eq(memoryConnection.appUrn, appUrn)).execute();

    return result.rowCount ?? 0;
  }
}
