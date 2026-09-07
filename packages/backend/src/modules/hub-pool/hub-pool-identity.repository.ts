import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { hubPoolIdentity } from '@/core/database/drizzle/schema';

/** The one row of `hub_pool_identity`, id `'self'` (a CHECK constraint enforces the singleton). */
export const HUB_POOL_IDENTITY_ID = 'self';

export interface HubPoolIdentityRow {
  id: string;
  nodeUuid: string;
  publicKey: string;
  privateKeyEncrypted: string;
  algorithm: string;
  createdAt: string;
  rotatedAt: string | null;
}

@Injectable()
export class HubPoolIdentityRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async get(): Promise<HubPoolIdentityRow | undefined> {
    return this.db.query.hubPoolIdentity.findFirst({ where: eq(hubPoolIdentity.id, HUB_POOL_IDENTITY_ID) });
  }

  /**
   * Create the identity only if there isn't one, then let the caller re-read.
   *
   * `ON CONFLICT DO NOTHING` rather than a read-then-write: the desktop wrapper can double-start the
   * backend during an upgrade, and two racing boots that both minted would leave this node with two
   * public keys while every peer has pinned exactly one of them.
   */
  async insertIfAbsent(row: Omit<HubPoolIdentityRow, 'id' | 'createdAt' | 'rotatedAt'>): Promise<void> {
    await this.db
      .insert(hubPoolIdentity)
      .values({ id: HUB_POOL_IDENTITY_ID, ...row })
      .onConflictDoNothing()
      .execute();
  }

  /** Replace the keypair while keeping `nodeUuid` — a rotation changes the key, never the identity. */
  async replaceKeys(publicKey: string, privateKeyEncrypted: string): Promise<void> {
    await this.db
      .update(hubPoolIdentity)
      .set({ publicKey, privateKeyEncrypted, rotatedAt: new Date().toISOString() })
      .where(eq(hubPoolIdentity.id, HUB_POOL_IDENTITY_ID))
      .execute();
  }
}
