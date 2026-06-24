import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { FactoryResetController } from '../factory-reset.controller';
import { FactoryResetService } from '../factory-reset.service';

describe('FactoryResetController', () => {
  let controller: FactoryResetController;
  let factoryResetService: MockProxy<FactoryResetService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FactoryResetController],
      providers: [{ provide: FactoryResetService, useValue: mock<FactoryResetService>() }],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(FactoryResetController);
    factoryResetService = moduleRef.get(FactoryResetService);
    factoryResetService.execute.mockResolvedValue({ success: true, message: 'done' });
  });

  it('rejects non-operator users', async () => {
    await expect(controller.factoryReset({ user: { id: 1, operator: false } } as any, { confirmation: 'factory-reset' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('runs factory reset for operators', async () => {
    const result = await controller.factoryReset({ user: { id: 1, operator: true } } as any, { confirmation: 'factory-reset' });

    expect(factoryResetService.execute).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
