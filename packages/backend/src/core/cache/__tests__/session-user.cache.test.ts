import { SessionUserCache } from '@/core/cache/session-user.cache';
import type { UserDto } from '@/modules/user/dto/user.dto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dto = (id: number, extra: Partial<UserDto> = {}) => ({ id, ...extra }) as UserDto;

describe('SessionUserCache', () => {
  let cache: SessionUserCache;

  beforeEach(() => {
    cache = new SessionUserCache();
  });

  it('returns a stored DTO and drops it on invalidate', () => {
    cache.set(1, dto(1));
    expect(cache.get(1)).toEqual(dto(1));

    cache.invalidate(1);

    expect(cache.get(1)).toBeUndefined();
  });

  it('invalidates only the named user', () => {
    cache.set(1, dto(1));
    cache.set(2, dto(2));

    cache.invalidate(1);

    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toEqual(dto(2));
  });

  it('clears every entry when invalidate is called with no user', () => {
    cache.set(1, dto(1));
    cache.set(2, dto(2));

    cache.invalidate();

    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBeUndefined();
  });

  describe('read tokens', () => {
    /**
     * The bug this guards: AuthMiddleware misses, issues a SELECT, and the row is written and
     * invalidated while that SELECT is in flight. Storing the result unconditionally puts the
     * pre-write DTO back for a fresh TTL — exactly the stale `hasCompletedOnboarding: false`
     * that bounces a user who just finished onboarding back into the wizard.
     */
    it('MUST refuse a read that was overtaken by an invalidation', () => {
      const readToken = cache.beginRead(1);

      cache.invalidate(1);
      cache.set(1, dto(1, { hasCompletedOnboarding: false }), readToken);

      expect(cache.get(1)).toBeUndefined();
    });

    /**
     * The stamp is per user. A single process-wide counter also refused reads of users nobody
     * touched, so on a Hub with any concurrent traffic one write emptied every in-flight fill
     * and the cache stored nothing — every request then paid the SELECT this exists to avoid.
     */
    it('MUST still store the read when a different user was the one invalidated', () => {
      const readToken = cache.beginRead(1);

      cache.invalidate(2);
      cache.set(1, dto(1), readToken);

      expect(cache.get(1)).toEqual(dto(1));
    });

    /** A full flush has no user to name, so it has to refuse every read in flight. */
    it('MUST refuse a read that a whole-cache invalidation overtook', () => {
      const readToken = cache.beginRead(1);

      cache.invalidate();
      cache.set(1, dto(1), readToken);

      expect(cache.get(1)).toBeUndefined();
    });

    it('stores a read that no invalidation overtook', () => {
      const readToken = cache.beginRead(1);

      cache.set(1, dto(1), readToken);

      expect(cache.get(1)).toEqual(dto(1));
    });

    it('stores unconditionally when no token is supplied', () => {
      cache.invalidate(1);

      cache.set(1, dto(1));

      expect(cache.get(1)).toEqual(dto(1));
    });
  });

  describe('expiry', () => {
    /**
     * A monotonic stamp freezes while the appliance is suspended, so an entry written before the
     * lid closed came back looking seconds old. Wall clock is what makes the TTL a real bound.
     */
    it('MUST expire an entry once the TTL has elapsed in wall-clock time', () => {
      vi.useFakeTimers();
      try {
        cache.set(1, dto(1));
        vi.advanceTimersByTime(10_000);

        expect(cache.get(1)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    /** An NTP step backwards must not pin an entry past its TTL by making its age negative. */
    it('MUST expire an entry whose age went negative', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
        cache.set(1, dto(1));

        vi.setSystemTime(new Date('2026-08-14T11:59:59Z'));

        expect(cache.get(1)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('evicts the least recently used entry past the cap, keeping the freshly read one', () => {
    for (let id = 1; id <= 64; id += 1) {
      cache.set(id, dto(id));
    }

    // Re-reading 1 makes it the most recent, so 2 becomes the eviction candidate.
    expect(cache.get(1)).toBeDefined();
    cache.set(65, dto(65));

    expect(cache.get(1)).toEqual(dto(1));
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(65)).toEqual(dto(65));
  });
});
