import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { DockerModule } from '../docker/docker.module';
import { SubnetManagerService } from './subnet-manager.service';
import { PortManagerService } from './port-manager.service';
import { PortAllocationRepository } from './port-allocation.repository';
import { PortController } from './port.controller';

@Module({
  imports: [AppsModule, DockerModule],
  controllers: [PortController],
  providers: [SubnetManagerService, PortManagerService, PortAllocationRepository],
  exports: [SubnetManagerService, PortManagerService, PortAllocationRepository],
})
export class NetworkModule {}
