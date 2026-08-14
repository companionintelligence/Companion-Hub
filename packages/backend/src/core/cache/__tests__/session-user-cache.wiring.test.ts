import { CacheModule } from '@/core/cache/cache.module';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { DATABASE } from '@/core/database/database.module';
import type { UserDto } from '@/modules/user/dto/user.dto';
import { UserModule } from '@/modules/user/user.module';
import { UserRepository } from '@/modules/user/user.repository';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

const mockDb = {
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  }),
};

/** Stands in for the real (also @Global) DatabaseModule, which would open a Postgres connection. */
@Global()
@Module({ providers: [{ provide: DATABASE, useValue: mockDb }], exports: [DATABASE] })
class StubDatabaseModule {}

/**
 * The stale-onboarding fix rests on there being exactly ONE SessionUserCache: AuthMiddleware
 * fills it, UserRepository.updateUser clears it. A second instance — from re-declaring the
 * provider in a feature module instead of consuming the global one — silently restores the bug,
 * because the write clears one map while requests read the other.
 *
 * CacheModule and UserModule are the real modules here on purpose: this asserts the wiring,
 * not a hand-assembled provider list that cannot notice the wiring drifting.
 */
describe('SessionUserCache wiring', () => {
  it('MUST clear the globally shared cache entry when the user module writes the user row', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubDatabaseModule, CacheModule, UserModule],
    })
      // CacheService opens a real SQLite file on construction; irrelevant to this assertion.
      .overrideProvider(CacheService)
      .useValue({})
      .compile();

    const repository = moduleRef.get(UserRepository, { strict: false });
    const cache = moduleRef.get(SessionUserCache, { strict: false });

    cache.set(1, { id: 1, hasCompletedOnboarding: false } as UserDto);
    expect(cache.get(1)).toBeDefined();

    await repository.updateUser(1, { hasCompletedOnboarding: true });

    expect(cache.get(1)).toBeUndefined();
  });
});
