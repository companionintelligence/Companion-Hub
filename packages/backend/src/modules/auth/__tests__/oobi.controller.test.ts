import { ExecutionContext, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
});
