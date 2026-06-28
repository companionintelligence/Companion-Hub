import { describe, it, expect, beforeEach } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import { TranslatableError } from '@/common/error/translatable-error';
import { RegistrationGuard } from '../registration.guard';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { RegistrationService } from '../registration.service';

describe('RegistrationGuard', () => {
  let guard: RegistrationGuard;
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;
  let registrationService: MockProxy<RegistrationService>;

  beforeEach(() => {
    logger = mock<LoggerService>();
    config = mock<ConfigurationService>();
    registrationService = mock<RegistrationService>();
    guard = new RegistrationGuard(logger, config, registrationService);
  });

  function createContext(url = '/api/protected'): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ url }),
      }),
    } as ExecutionContext;
  }

  it('allows access when CI Cloud integration is not configured', async () => {
    config.getConfig.mockReturnValue({ ciCloudUrl: '' } as any);

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
    expect(registrationService.getLiveRegistrationStatus).not.toHaveBeenCalled();
  });

  it('allows access when live registration status is operational', async () => {
    config.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);
    registrationService.getLiveRegistrationStatus.mockResolvedValue({
      phase: 'locally_ready',
      degradedReasons: [],
      registered: true,
    });

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
    expect(registrationService.getLiveRegistrationStatus).toHaveBeenCalledOnce();
  });

  it('denies access when live registration status is not operational', async () => {
    config.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);
    registrationService.getLiveRegistrationStatus.mockResolvedValue({
      phase: 'unregistered',
      degradedReasons: [],
      registered: false,
    });

    await expect(guard.canActivate(createContext('/api/auth/login'))).rejects.toMatchObject({
      getStatus: expect.any(Function),
    });

    try {
      await guard.canActivate(createContext('/api/auth/login'));
      expect.fail('expected guard to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(TranslatableError);
      expect((error as TranslatableError).getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect((error as TranslatableError).getResponse()).toMatchObject({
        message: 'REGISTRATION_DEVICE_NOT_OPERATIONAL',
        intlParams: { phase: 'unregistered' },
      });
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('device not operational'));
  });
});
