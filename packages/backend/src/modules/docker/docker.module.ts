import { Module } from '@nestjs/common';
import Dockerode from 'dockerode';
import { AppsDataModule } from '../apps/apps-data.module';
import { DOCKERODE } from './constants';
import { DockerReadFacade } from './docker-read.facade';
import { DockerService } from './docker.service';
import { HubAppNetworkService } from './hub-app-networks.service';
import { TraefikConfigService } from './traefik-config.service';

// biome-ignore lint/performance/noBarrelFile: This is a module entry point
export { DOCKERODE } from './constants';

@Module({
  // AppsDataModule has no Marketplace/Docker imports — keeps Docker out of the
  // Marketplace ↔ Portal ↔ Cloudflare ↔ Docker service cycle.
  imports: [AppsDataModule],
  providers: [
    DockerReadFacade,
    DockerService,
    HubAppNetworkService,
    TraefikConfigService,
    {
      provide: DOCKERODE,
      useFactory: (): Dockerode => new Dockerode(),
      inject: [],
    },
  ],
  exports: [DockerReadFacade, DockerService, HubAppNetworkService, TraefikConfigService, DOCKERODE],
})
export class DockerModule {}
