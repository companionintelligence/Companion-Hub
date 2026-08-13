import { Injectable } from '@nestjs/common';
import type { UserDto } from '../user/dto/user.dto';

/**
 * Short-lived per-process cache for AuthMiddleware session → user DTO lookups.
 * Cuts repeated `getUserDtoById` on Hub API fan-out (store browse, shell queries).
 *
 * Invalidate on logout / password change / user profile updates so identity cannot
 * leak across sessions after mutation.
 */
@Injectable()
export class SessionUserCache {
  private static readonly TTL_MS = 10_000;
  private static readonly MAX_ENTRIES = 64;

  private readonly entries = new Map<number, { user: UserDto; at: number }>();

  get(userId: number): UserDto | undefined {
    const entry = this.entries.get(userId);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.at >= SessionUserCache.TTL_MS) {
      this.entries.delete(userId);
      return undefined;
    }
    // LRU: move to end
    this.entries.delete(userId);
    this.entries.set(userId, entry);
    return entry.user;
  }

  set(userId: number, user: UserDto) {
    if (this.entries.has(userId)) {
      this.entries.delete(userId);
    }
    this.entries.set(userId, { user, at: Date.now() });
    while (this.entries.size > SessionUserCache.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  invalidate(userId?: number) {
    if (userId === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(userId);
  }
}
