import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { RegistrationService } from '@/modules/registration/registration.service';
import { FactoryResetController } from '../factory-reset.controller';
import { FactoryResetService } from '../factory-reset.service';

describe('FactoryResetController', () => {
  let controller: FactoryResetController;
  let factoryResetService: MockProxy<FactoryResetService>;
  let registrationService: MockProxy<RegistrationService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FactoryResetController],
      providers: [
        { provide: FactoryResetService, useValue: mock<FactoryResetService>() },
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(DemoModeGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(FactoryResetController);
    factoryResetService = moduleRef.get(FactoryResetService);
    registrationService = moduleRef.get(RegistrationService);
    factoryResetService.execute.mockResolvedValue({ success: true, message: 'done' });
    registrationService.getDeviceRegistrationInfo.mockResolvedValue({
      slug: 'acme',
      hubSubdomain: 'hub-core-acme',
    } as Awaited<ReturnType<RegistrationService['getDeviceRegistrationInfo']>>);
  });

  it('rejects non-operator users', async () => {
    await expect(controller.factoryReset({ user: { id: 1, operator: false } } as any, { confirmation: 'core' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(factoryResetService.execute).not.toHaveBeenCalled();
  });

  it('rejects a confirmation that is not this device name', async () => {
    await expect(controller.factoryReset({ user: { id: 1, operator: true } } as any, { confirmation: 'factory-reset' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(factoryResetService.execute).not.toHaveBeenCalled();
  });

  it('rejects the reset when this Hub has no device name', async () => {
    registrationService.getDeviceRegistrationInfo.mockResolvedValue(null);

    await expect(controller.factoryReset({ user: { id: 1, operator: true } } as any, { confirmation: 'core' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(factoryResetService.execute).not.toHaveBeenCalled();
  });

  it('runs factory reset when the operator types this device name', async () => {
    const result = await controller.factoryReset({ user: { id: 1, operator: true } } as any, { confirmation: 'core' });

    expect(factoryResetService.execute).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
