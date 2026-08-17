import { Injectable } from '@nestjs/common';
import type { UserDto } from '@/modules/user/dto/user.dto';

/**
 * The cache state a read started from. `set` compares it field for field: `epoch` catches a
 * whole-cache flush, `version` catches an invalidation that named this particular user.
 */
export type SessionUserReadToken = { readonly epoch: number; readonly version: number };

/**
 * Short-lived per-process cache for AuthMiddleware session → user DTO lookups.
 * Cuts repeated `getUserDtoById` on Hub API fan-out (store browse, shell queries).
 *
 * `UserRepository` invalidates on every write to the user row — `updateUser` and
 * `createUser`, the choke point the ordinary mutations share. Invalidating at individual
 * call sites instead left the cached DTO serving pre-write values for up to TTL_MS:
 * finishing onboarding wrote `hasCompletedOnboarding: true`, the very next
 * `GET /app-context` answered `false` from here, and the `/home` route guard bounced the
 * user back into the wizard. Writers that go around the repository — `FactoryResetService`
 * truncates the table in raw SQL — must call `invalidate()` themselves.
 *
 * Reads are guarded by a version stamp rather than a bare delete: `AuthMiddleware` takes a
 * token from `beginRead()` before its `SELECT` and hands it back to `set`, so a read that was
 * already in flight when a write invalidated cannot re-arm the pre-write DTO for another full
 * TTL. Without that, the onboarding bug above survived the invalidation whenever a background
 * poll happened to be mid-lookup. The stamp is per user, not a single process-wide counter:
 * one shared counter made any write to any user throw away every other user's in-flight fill,
 * so on a Hub with concurrent traffic the cache stored nothing and every request paid the
 * SELECT it exists to avoid.
 *
 * Lives in the global CacheModule rather than the auth module so the user module
 * can reach it without importing auth (which imports the user module).
 */
@Injectable()
export class SessionUserCache {
  private static readonly TTL_MS = 10_000;
  private static readonly MAX_ENTRIES = 64;

  private readonly entries = new Map<number, { user: UserDto; at: number }>();

  /** Bumped by a whole-cache flush; refuses the in-flight reads of every user at once. */
  private epoch = 0;

  /** Per-user invalidation count, so one user's write cannot refuse another user's read. */
  private readonly versions = new Map<number, number>();

  /**
   * Token for the cache state a read starts from. Pass it back to `set` — if this user was
   * invalidated in between, the value read is potentially pre-write and is dropped.
   */
  beginRead(userId: number): SessionUserReadToken {
    return { epoch: this.epoch, version: this.versionOf(userId) };
  }

  get(userId: number): UserDto | undefined {
    const entry = this.entries.get(userId);
    if (!entry) {
      return undefined;
    }
    // Wall clock rather than `performance.now()`: a monotonic stamp stops advancing while the
    // appliance is suspended, so an entry written before the lid closed would still look fresh
    // on resume. Treating a negative age as expired is what covers the other direction — an NTP
    // step backwards across the stamp, which would otherwise pin the entry past its TTL.
    const age = Date.now() - entry.at;
    if (age < 0 || age >= SessionUserCache.TTL_MS) {
      this.entries.delete(userId);
      return undefined;
    }
    // LRU: move to end
    this.entries.delete(userId);
    this.entries.set(userId, entry);
    return entry.user;
  }

  /**
   * @param readToken - value from `beginRead()` taken before the lookup this stores the result
   *   of. Omit only when the value cannot be stale (it was just written).
   */
  set(userId: number, user: UserDto, readToken?: SessionUserReadToken) {
    if (readToken && (readToken.epoch !== this.epoch || readToken.version !== this.versionOf(userId))) {
      // Invalidated while this read was in flight — the row may already have moved on.
      return;
    }
    // Re-insert so the entry lands at the end of the LRU order.
    this.entries.delete(userId);
    this.entries.set(userId, { user, at: Date.now() });
    if (this.entries.size > SessionUserCache.MAX_ENTRIES) {
      // `set` adds at most one entry, so at most one eviction can ever be due.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  /** Drop one user's entry, or the whole map when called with no argument. */
  invalidate(userId?: number) {
    if (userId === undefined) {
      this.epoch += 1;
      this.entries.clear();
      this.versions.clear();
      return;
    }

    this.versions.set(userId, this.versionOf(userId) + 1);
    this.entries.delete(userId);

    if (this.versions.size > SessionUserCache.MAX_ENTRIES) {
      // Bounded like `entries`. Dropping the counters alone would let an in-flight read that
      // predates an invalidation look current, so bump the epoch too: that refuses every
      // outstanding read, which is the safe side of the trade.
      this.epoch += 1;
      this.versions.clear();
    }
  }

  private versionOf(userId: number): number {
    return this.versions.get(userId) ?? 0;
  }
}
