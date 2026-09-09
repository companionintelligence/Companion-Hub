import { SessionUserCache } from '@/core/cache/session-user.cache';
import { DATABASE, type Database } from '@/core/database/database.module';
import { user } from '@/core/database/drizzle/schema';
import type { NewUser } from '@/core/database/drizzle/types';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm/sql';

@Injectable()
export class UserRepository {
  constructor(
    @Inject(DATABASE) private db: Database,
    private readonly sessionUserCache: SessionUserCache,
  ) {}

  /**
   * Given a username, return the user associated to it
   *
   * @param {string} username - The username of the user to return
   */
  public async getUserByUsername(username: string) {
    return this.db.query.user.findFirst({ where: eq(user.username, username.trim().toLowerCase()) });
  }

  /**
   * Given a userId, return the user associated to it
   *
   * @param {number} id - The id of the user to return
   */
  public async getUserById(id: number) {
    return this.db.query.user.findFirst({ where: eq(user.id, Number(id)) });
  }

  /**
   * Given a userId, return the user associated to it with only the id, username, and totpEnabled fields
   *
   * @param {number} id - The id of the user to return
   */
  public async getUserDtoById(id: number) {
    return this.db.query.user.findFirst({
      where: eq(user.id, Number(id)),
      columns: {
        id: true,
        username: true,
        totpEnabled: true,
        locale: true,
        operator: true,
        hasCompletedOnboarding: true,
        advancedMode: true,
      },
    });
  }

  /**
   * Given a userId, update the user with the given data
   *
   * Drops the cached session DTO for this user: `getUserDtoById` feeds a 10s cache that
   * `AuthMiddleware` reads into `req.user`, which `GET /app-context` returns verbatim. Without
   * this, a caller that flips `hasCompletedOnboarding`, `totpEnabled`, `advancedMode` or the
   * username sees its own write ignored until the entry expires.
   *
   * @param {number} id - The id of the user to update
   * @param {Partial<NewUser>} data - The data to update the user with
   */
  public async updateUser(id: number, data: Partial<NewUser>) {
    // One coercion for both the row and the cache key: two would be free to drift apart, and a
    // cache key that disagrees with the WHERE clause invalidates nobody while the row changes.
    const userId = Number(id);

    try {
      const updatedUsers = await this.db.update(user).set(data).where(eq(user.id, userId)).returning();
      return updatedUsers[0];
    } finally {
      // In `finally` because the UPDATE can commit and still reject on the way back (the
      // transient `ci-hub-db` drops this codebase retries elsewhere) — a committed write whose
      // cache entry survived is the stale read this cache exists to avoid.
      this.sessionUserCache.invalidate(userId);
    }
  }

  /**
   * Returns all operators registered in the system
   */
  public async getOperators() {
    return this.db.select().from(user).where(eq(user.operator, true));
  }

  /**
   * Returns the first operator found in the system
   *
   * Projected to the same columns as `getUserDtoById`: `AuthMiddleware` assigns this straight to
   * `req.user` on the API-key and CLI-JWT paths, and `GET /app-context` serializes `req.user`
   * through a `reportOnly` parse that hands back the raw object when validation fails. An
   * unprojected row would put the operator's password hash, salt and TOTP secret on that wire.
   */
  public async getFirstOperator() {
    return this.db.query.user.findFirst({
      where: eq(user.operator, true),
      // Ordered because Portal SSO compares the caller's address against THIS row: without it the
      // row is heap order, so on a multi-operator Hub the same login can be accepted one day and
      // refused the next. Oldest operator wins, which is the one that claimed the appliance.
      orderBy: (row, { asc }) => asc(row.id),
      columns: {
        id: true,
        username: true,
        totpEnabled: true,
        locale: true,
        operator: true,
        hasCompletedOnboarding: true,
        advancedMode: true,
      },
    });
  }

  /**
   * Given user data, creates a new user
   *
   * Invalidates the cached DTO for the new id as well: `FactoryResetService` truncates the
   * user table with `RESTART IDENTITY`, so a fresh account can be handed an id that a cached
   * entry still describes — without this the new operator would be served the deleted one's
   * username and `hasCompletedOnboarding` for the rest of the TTL.
   *
   * @param {NewUser} data - The data to create the user with
   */
  public async createUser(data: NewUser) {
    const newUsers = await this.db.insert(user).values(data).returning();
    const created = newUsers[0];

    if (created) {
      this.sessionUserCache.invalidate(created.id);
    }

    return created;
  }

  /**
   * Hub onboarding is appliance setup, not a per-person wizard. Finishing it
   * (or inheriting it onto a later family operator) must flip every operator
   * so the next sign-in lands on the dashboard.
   */
  public async markApplianceOnboardingComplete() {
    const updated = await this.db.update(user).set({ hasCompletedOnboarding: true }).where(eq(user.operator, true)).returning({ id: user.id });

    for (const row of updated) {
      this.sessionUserCache.invalidate(row.id);
    }

    return updated;
  }
}
