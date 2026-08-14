import { Injectable } from '@nestjs/common';
import type { UserDto } from '@/modules/user/dto/user.dto';

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
 * Reads are guarded by a generation counter rather than a bare delete: `AuthMiddleware`
 * takes a token from `beginRead()` before its `SELECT` and hands it back to `set`, so a
 * read that was already in flight when a write invalidated cannot re-arm the pre-write DTO
 * for another full TTL. Without that, the onboarding bug above survived the invalidation
 * whenever a background poll happened to be mid-lookup.
 *
 * Lives in the global CacheModule rather than the auth module so the user module
 * can reach it without importing auth (which imports the user module).
 */
@Injectable()
export class SessionUserCache {
  private static readonly TTL_MS = 10_000;
  private static readonly MAX_ENTRIES = 64;

  private readonly entries = new Map<number, { user: UserDto; at: number }>();

  /** Bumped by every invalidation; stamps reads so a stale one cannot be stored. */
  private generation = 0;

  /**
   * Token for the cache state a read starts from. Pass it back to `set` — if anything was
   * invalidated in between, the value read is potentially pre-write and is dropped.
   */
  beginRead(): number {
    return this.generation;
  }

  get(userId: number): UserDto | undefined {
    const entry = this.entries.get(userId);
    if (!entry) {
      return undefined;
    }
    if (performance.now() - entry.at >= SessionUserCache.TTL_MS) {
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
  set(userId: number, user: UserDto, readToken?: number) {
    if (readToken !== undefined && readToken !== this.generation) {
      // Invalidated while this read was in flight — the row may already have moved on.
      return;
    }
    if (this.entries.has(userId)) {
      this.entries.delete(userId);
    }
    // Monotonic: the appliance sleeps and resumes, and an NTP step backwards across a
    // wall-clock stamp would make the age negative and hold the entry past its TTL.
    this.entries.set(userId, { user, at: performance.now() });
    while (this.entries.size > SessionUserCache.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  /** Drop one user's entry, or the whole map when called with no argument. */
  invalidate(userId?: number) {
    this.generation += 1;
    if (userId === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(userId);
  }
}
