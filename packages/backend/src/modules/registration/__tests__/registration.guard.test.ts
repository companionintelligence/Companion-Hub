import { describe, it, expect, beforeEach } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
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

    await expect(guard.canActivate(createContext('/api/auth/login'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('device not operational'));
  });
});
