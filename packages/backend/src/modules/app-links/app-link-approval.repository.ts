import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { appLinkApproval } from '@/core/database/drizzle/schema';
import type { LinkPlanApproval } from './app-link-plan';

/** Data access for `app_link_approval`: one row per (consumer, provider) the operator allowed. */
@Injectable()
export class AppLinkApprovalRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<LinkPlanApproval[]> {
    return this.db
      .select({
        consumerUrn: appLinkApproval.consumerUrn,
        providerUrn: appLinkApproval.providerUrn,
        service: appLinkApproval.service,
        alias: appLinkApproval.alias,
      })
      .from(appLinkApproval);
  }

  /** Records the operator's leave, replacing an earlier one for the same pair. */
  async approve(row: LinkPlanApproval & { approvedByUserId?: number | null }): Promise<void> {
    await this.db
      .insert(appLinkApproval)
      .values({ ...row, approvedByUserId: row.approvedByUserId ?? null })
      .onConflictDoUpdate({
        target: [appLinkApproval.consumerUrn, appLinkApproval.providerUrn],
        set: { service: row.service, alias: row.alias, approvedByUserId: row.approvedByUserId ?? null },
      });
  }

  /** Withdraws it. True when there was one. */
  async revoke(consumerUrn: string, providerUrn: string): Promise<boolean> {
    const removed = await this.db
      .delete(appLinkApproval)
      .where(and(eq(appLinkApproval.consumerUrn, consumerUrn), eq(appLinkApproval.providerUrn, providerUrn)))
      .returning({ id: appLinkApproval.id });
    return removed.length > 0;
  }

  /** Drops every leave that names an app, when it is uninstalled. */
  async forgetApp(appUrn: string): Promise<void> {
    await this.db.delete(appLinkApproval).where(eq(appLinkApproval.consumerUrn, appUrn));
    await this.db.delete(appLinkApproval).where(eq(appLinkApproval.providerUrn, appUrn));
  }
}
