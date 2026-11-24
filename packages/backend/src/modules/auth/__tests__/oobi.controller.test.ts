import { BadRequestException, ExecutionContext, NotFoundException, RequestMethod, ServiceUnavailableException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KERI_OOBI_FLAG, KeriOobiFlagGuard } from '../keri-oobi.guard';
import { OobiController } from '../oobi.controller';

describe('OobiController and KeriOobiFlagGuard', () => {
  const controller = new OobiController();
  const guard = new KeriOobiFlagGuard();
  const originalEnv = process.env[KERI_OOBI_FLAG];

  beforeEach(() => {
    delete process.env[KERI_OOBI_FLAG];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[KERI_OOBI_FLAG];
    } else {
      process.env[KERI_OOBI_FLAG] = originalEnv;
    }
  });

  it('fails closed with 404 NotFoundException when CI_HUB_KERI_OOBI is not set or false', () => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', originalUrl: '/.well-known/keri/oobi' }),
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(mockContext)).toThrow(NotFoundException);

    process.env[KERI_OOBI_FLAG] = 'false';
    expect(() => guard.canActivate(mockContext)).toThrow(NotFoundException);
  });

  it('allows activation when CI_HUB_KERI_OOBI=true', () => {
    process.env[KERI_OOBI_FLAG] = 'true';
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', originalUrl: '/.well-known/keri/oobi' }),
      }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(mockContext)).toBe(true);
  });

  it('does not publish placeholder identity data when no persisted KERI log exists', () => {
    expect(() => controller.getHubOobi()).toThrow(ServiceUnavailableException);
  });

  it('does not claim to resolve an AID without verifying a persisted KERI log', () => {
    expect(() => controller.getOobiForAid('did:keri:example')).toThrow(ServiceUnavailableException);
  });

  describe('NestJS decorator metadata, DI resolution, and guard-before-handler execution', () => {
    it('binds KeriOobiFlagGuard at controller scope and exposes .well-known/keri/oobi GET routes', () => {
      const classGuards = Reflect.getMetadata(GUARDS_METADATA, OobiController) as unknown[];
      expect(classGuards).toContain(KeriOobiFlagGuard);

      const rootProto = OobiController.prototype.getHubOobi;
      expect(Reflect.getMetadata(PATH_METADATA, rootProto)).toBe('.well-known/keri/oobi');
      expect(Reflect.getMetadata(METHOD_METADATA, rootProto)).toBe(RequestMethod.GET);

      const aidProto = OobiController.prototype.getOobiForAid;
      expect(Reflect.getMetadata(PATH_METADATA, aidProto)).toBe('.well-known/keri/oobi/:aid');
      expect(Reflect.getMetadata(METHOD_METADATA, aidProto)).toBe(RequestMethod.GET);
    });

    it('resolves OobiController and KeriOobiFlagGuard through TestingModule and enforces 404 -> 503/400 transitions', async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [OobiController],
      }).compile();

      const resolvedController = moduleRef.get(OobiController);
      const resolvedGuard = new KeriOobiFlagGuard();

      const runThroughGuard = (url: string, handler: () => never) => {
        const ctx = {
          switchToHttp: () => ({
            getRequest: () => ({ method: 'GET', originalUrl: url }),
          }),
        } as unknown as ExecutionContext;
        if (resolvedGuard.canActivate(ctx)) {
          return handler();
        }
        throw new Error('unreachable');
      };

      // Disabled by default and when non-'true': guard throws 404 before handler runs
      for (const flagValue of [undefined, 'false', '1', 'yes']) {
        if (flagValue === undefined) {
          delete process.env[KERI_OOBI_FLAG];
        } else {
          process.env[KERI_OOBI_FLAG] = flagValue;
        }
        expect(() => runThroughGuard('/.well-known/keri/oobi', () => resolvedController.getHubOobi())).toThrow(NotFoundException);
        expect(() => runThroughGuard('/.well-known/keri/oobi/ELC7example', () => resolvedController.getOobiForAid('ELC7example'))).toThrow(
          NotFoundException,
        );
      }

      // Enabled with CI_HUB_KERI_OOBI=true: guard passes and handlers enforce validation/unconfigured 503
      process.env[KERI_OOBI_FLAG] = 'true';
      expect(() => runThroughGuard('/.well-known/keri/oobi', () => resolvedController.getHubOobi())).toThrow(ServiceUnavailableException);
      expect(() => runThroughGuard('/.well-known/keri/oobi/ELC7example', () => resolvedController.getOobiForAid('ELC7example'))).toThrow(
        ServiceUnavailableException,
      );
      expect(() => runThroughGuard('/.well-known/keri/oobi/%20', () => resolvedController.getOobiForAid('   '))).toThrow(BadRequestException);

      await moduleRef.close();
    });
  });
});
