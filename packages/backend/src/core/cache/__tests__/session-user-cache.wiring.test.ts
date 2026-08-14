import { CacheModule } from '@/core/cache/cache.module';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { DATABASE } from '@/core/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import type { UserDto } from '@/modules/user/dto/user.dto';
import { UserModule } from '@/modules/user/user.module';
import { UserRepository } from '@/modules/user/user.repository';
import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

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
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    // Closed here rather than at the end of each test: a failing assertion returns first, and
    // these are the runs where a leaked Nest graph would pile up for the rest of the file.
    await moduleRef?.close();
    moduleRef = undefined;
    vi.clearAllMocks();
  });

  const compileGraph = async () => {
    moduleRef = await Test.createTestingModule({ imports: [StubDatabaseModule, CacheModule, UserModule] })
      // CacheService opens a real SQLite file on construction; irrelevant to these assertions.
      .overrideProvider(CacheService)
      .useValue(mock<CacheService>())
      .compile();
    return moduleRef;
  };

  it('MUST clear the globally shared cache entry when the user module writes the user row', async () => {
    const graph = await compileGraph();

    const repository = graph.get(UserRepository, { strict: false });
    const cache = graph.get(SessionUserCache, { strict: false });

    cache.set(1, { id: 1, hasCompletedOnboarding: false } as UserDto);
    expect(cache.get(1)).toBeDefined();

    await repository.updateUser(1, { hasCompletedOnboarding: true });

    expect(cache.get(1)).toBeUndefined();
  });

  /**
   * The assertion above cannot fail on its own: `get(..., { strict: false })` returns the LAST
   * registered instance, which is the very one a duplicate-declaring UserModule would have
   * injected into UserRepository — so both halves move together and the split goes unseen.
   * Counting the instance links is what actually pins "exactly one".
   */
  it('MUST resolve exactly one SessionUserCache instance across the module graph', async () => {
    const graph = await compileGraph();

    expect(graph.get(SessionUserCache, { strict: false, each: true })).toHaveLength(1);
  });

  /**
   * AuthModule is the module the provider was actually moved out of, and it is far too heavy to
   * compile here (Docker, encryption, registration). Reading its metadata catches a re-declared
   * provider — the regression that would give AuthMiddleware its own private map — without
   * instantiating anything.
   */
  it('MUST NOT let AuthModule re-declare the provider AuthMiddleware reads through', () => {
    const authProviders: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) ?? [];

    // Matched by token, not by reference: `{ provide: SessionUserCache, useClass: ... }` mints a
    // second instance every bit as much as the bare class does, and `toContain` would miss it.
    const declaresSessionUserCache = authProviders.some(
      (provider) => provider === SessionUserCache || (provider as { provide?: unknown } | null)?.provide === SessionUserCache,
    );

    expect(declaresSessionUserCache).toBe(false);
  });
});
