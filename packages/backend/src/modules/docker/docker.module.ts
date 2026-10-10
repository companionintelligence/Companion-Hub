import { Module } from '@nestjs/common';
import Dockerode from 'dockerode';
import { AppsDataModule } from '../apps/apps-data.module';
import { AppVolumeArchiveService } from './app-volume-archive.service';
import { DOCKERODE } from './constants';
import { DockerReadFacade } from './docker-read.facade';
import { DockerService } from './docker.service';
import { TraefikConfigService } from './traefik-config.service';

// biome-ignore lint/performance/noBarrelFile: This is a module entry point
export { DOCKERODE } from './constants';

@Module({
  // AppsDataModule has no Marketplace/Docker imports — keeps Docker out of the
  // Marketplace ↔ Portal ↔ Cloudflare ↔ Docker service cycle.
  imports: [AppsDataModule],
  providers: [
    AppVolumeArchiveService,
    DockerReadFacade,
    DockerService,
    TraefikConfigService,
    {
      provide: DOCKERODE,
      useFactory: (): Dockerode => new Dockerode(),
      inject: [],
    },
  ],
  exports: [AppVolumeArchiveService, DockerReadFacade, DockerService, TraefikConfigService, DOCKERODE],
})
export class DockerModule {}
