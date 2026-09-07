import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { hubPoolPeer } from '@/core/database/drizzle/schema';
import type { HubPoolPeer, NewHubPoolPeer } from '@/core/database/drizzle/types';

@Injectable()
export class HubPoolPeerRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(data: NewHubPoolPeer): Promise<HubPoolPeer> {
    const [row] = await this.db.insert(hubPoolPeer).values(data).returning().execute();
    if (!row) {
      throw new Error('Failed to create hub_pool_peer row');
    }
    return row;
  }

  async findById(id: string): Promise<HubPoolPeer | undefined> {
    return this.db.query.hubPoolPeer.findFirst({ where: eq(hubPoolPeer.id, id) });
  }

  async findByNodeFqdn(nodeFqdn: string): Promise<HubPoolPeer | undefined> {
    return this.db.query.hubPoolPeer.findFirst({ where: eq(hubPoolPeer.nodeFqdn, nodeFqdn) });
  }

  /**
   * Resolve a peer by its pinned pool UUID — the lookup the signed-request guard uses.
   *
   * Backed by the partial unique index from migration 0059, so at most one row can ever answer.
   * Unlike {@link findByNodeFqdn} this survives the peer being renamed, which is the entire point
   * of storing a UUID alongside the address.
   */
  async findByNodeUuid(peerNodeUuid: string): Promise<HubPoolPeer | undefined> {
    return this.db.query.hubPoolPeer.findFirst({ where: eq(hubPoolPeer.peerNodeUuid, peerNodeUuid) });
  }

  async listAll(): Promise<HubPoolPeer[]> {
    return this.db.query.hubPoolPeer.findMany();
  }

  async listByStatus(status: string): Promise<HubPoolPeer[]> {
    return this.db.query.hubPoolPeer.findMany({ where: eq(hubPoolPeer.status, status) });
  }

  async listByStatuses(statuses: string[]): Promise<HubPoolPeer[]> {
    return this.db.query.hubPoolPeer.findMany({ where: inArray(hubPoolPeer.status, statuses) });
  }

  async update(id: string, data: Partial<NewHubPoolPeer>): Promise<HubPoolPeer | undefined> {
    const [row] = await this.db
      .update(hubPoolPeer)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(hubPoolPeer.id, id))
      .returning()
      .execute();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(hubPoolPeer).where(eq(hubPoolPeer.id, id)).execute();
  }
}
