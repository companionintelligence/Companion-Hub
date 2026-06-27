import { Module } from '@nestjs/common';
import Dockerode from 'dockerode';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/constants';
import { SubnetManagerService } from './subnet-manager.service';
import { PortManagerService } from './port-manager.service';
import { PortAllocationRepository } from './port-allocation.repository';
import { PortController } from './port.controller';
import { NetworkDiagnosticsService } from './network-diagnostics.service';
import { NetworkController } from './network.controller';

@Module({
  controllers: [PortController, NetworkController],
  providers: [
    AppsRepository,
    SubnetManagerService,
    PortManagerService,
    PortAllocationRepository,
    NetworkDiagnosticsService,
    {
      provide: DOCKERODE,
      useFactory: (): Dockerode => new Dockerode(),
      inject: [],
    },
  ],
  exports: [SubnetManagerService, PortManagerService, PortAllocationRepository, NetworkDiagnosticsService],
})
export class NetworkModule {}
