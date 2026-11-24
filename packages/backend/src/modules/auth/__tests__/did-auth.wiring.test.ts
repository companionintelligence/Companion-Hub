/**
 * The seam that decides whether the feature works at all with the flag on.
 *
 * `AuthController` takes `DidAuthService` as its last, `@Optional()` parameter, so a Hub whose
 * `AuthModule` stopped providing it would boot without a word and answer 404 to every DID route even
 * with `CI_HUB_DID_AUTH=true`. The unit tests build the controller by hand and the HTTP test builds its own
 * module, so neither can see that; this reads the real module.
 *
 * `AuthModule` is too heavy to compile here (Docker, encryption, registration), so, as
 * `session-user-cache.wiring.test.ts` does, its metadata is read, and the part that can be compiled is.
 */
import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { CacheModule } from '@/core/cache/cache.module';
import { CacheService } from '@/core/cache/cache.service';
import { DATABASE } from '@/core/database/database.module';
import { LoggerService } from '@/core/logger/logger.service';
import { UserModule } from '@/modules/user/user.module';
import { AuthController } from '../auth.controller';
import { AuthModule } from '../auth.module';
import { DidAuthService } from '../did-auth.service';
import { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';

/** Stands in for the real (also @Global) DatabaseModule, which would open a Postgres connection. */
@Global()
@Module({ providers: [{ provide: DATABASE, useValue: {} }], exports: [DATABASE] })
class StubDatabaseModule {}

describe('Sign in with a DID — wiring', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('AuthModule provides DidAuthService, by its class', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) ?? [];

    expect(providers).toContain(DidAuthService);
  });

  it('AuthController asks for that same class, as its last and only optional parameter', () => {
    const parameters: unknown[] = Reflect.getMetadata('design:paramtypes', AuthController);
    // Nest records an `@Optional()` parameter by its index.
    const optional: number[] = Reflect.getMetadata('optional:paramtypes', AuthController) ?? [];

    expect(parameters.at(-1)).toBe(DidAuthService);
    expect(optional).toEqual([parameters.length - 1]);
  });

  it('the dependencies of DidAuthService are all ones AuthModule can supply', async () => {
    // The real UserModule and CacheModule, the real DidAuthService and ForwardAuthIdentityResolver: if the
    // service grew a dependency this graph cannot resolve, Nest says so here rather than at the first boot.
    moduleRef = await Test.createTestingModule({
      imports: [StubDatabaseModule, CacheModule, UserModule],
      providers: [{ provide: LoggerService, useValue: mock<LoggerService>() }, ForwardAuthIdentityResolver, DidAuthService],
    })
      // CacheService opens a real SQLite file on construction; irrelevant to these assertions.
      .overrideProvider(CacheService)
      .useValue(mock<CacheService>())
      .compile();

    expect(moduleRef.get(DidAuthService)).toBeInstanceOf(DidAuthService);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule)).toContain(ForwardAuthIdentityResolver);
  });
});
