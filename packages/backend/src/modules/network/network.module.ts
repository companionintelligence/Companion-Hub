import { Module } from '@nestjs/common';
import Dockerode from 'dockerode';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/constants';
import { SubnetManagerService } from './subnet-manager.service';
import { PortManagerService } from './port-manager.service';
import { PortAllocationRepository } from './port-allocation.repository';
import { PortController } from './port.controller';

@Module({
  controllers: [PortController],
  providers: [
    AppsRepository,
    SubnetManagerService,
    PortManagerService,
    PortAllocationRepository,
    {
      provide: DOCKERODE,
      useFactory: (): Dockerode => new Dockerode(),
      inject: [],
    },
  ],
  exports: [SubnetManagerService, PortManagerService, PortAllocationRepository],
})
export class NetworkModule {}
