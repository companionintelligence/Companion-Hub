import { DATABASE } from '@/core/database/database.module';
import { LoggerService } from '@/core/logger/logger.service';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { NetworkModule } from '../network.module';
import { PortManagerService } from '../port-manager.service';
import { SubnetManagerService } from '../subnet-manager.service';

@Global()
@Module({
  providers: [
    { provide: DATABASE, useValue: {} },
    {
      provide: LoggerService,
      useValue: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    },
  ],
  exports: [DATABASE, LoggerService],
})
class TestNetworkDepsModule {}

describe('NetworkModule', () => {
  it('compiles with its local repository and Docker providers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestNetworkDepsModule, NetworkModule],
    }).compile();

    expect(moduleRef.get(PortManagerService)).toBeInstanceOf(PortManagerService);
    expect(moduleRef.get(SubnetManagerService)).toBeInstanceOf(SubnetManagerService);
  });
});
