import { DATABASE, type Database } from '@/core/database/database.module';
import { federatedIdentity } from '@/core/database/drizzle/schema';
import type { NewFederatedIdentity } from '@/core/database/drizzle/types';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm/sql';

/**
 * Persists the binding between a verified external OIDC identity — the
 * (issuer, subject) pair — and a local Hub `user`. See CI-Engineering
 * architecture/identity/unified-identity-plan.md (Track B, B2).
 */
@Injectable()
export class FederatedIdentityRepository {
  constructor(@Inject(DATABASE) private db: Database) {}

  /**
   * Return the federated-identity row for a given (issuer, subject) pair, if any.
   * The pair is unique, so at most one row is returned.
   */
  public async findByIssuerSubject(issuer: string, subject: string) {
    return this.db.query.federatedIdentity.findFirst({
      where: and(eq(federatedIdentity.issuer, issuer), eq(federatedIdentity.subject, subject)),
    });
  }

  /**
   * Return every federated identity linked to a given local user.
   */
  public async findByUserId(userId: number) {
    return this.db
      .select()
      .from(federatedIdentity)
      .where(eq(federatedIdentity.userId, Number(userId)));
  }

  /**
   * Create a federated-identity binding.
   */
  public async create(data: NewFederatedIdentity) {
    const rows = await this.db.insert(federatedIdentity).values(data).returning();
    return rows[0];
  }
}
