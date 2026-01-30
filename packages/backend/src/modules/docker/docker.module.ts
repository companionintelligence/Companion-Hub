import { Module, forwardRef } from '@nestjs/common';
import Dockerode from 'dockerode';
import { AppsModule } from '../apps/apps.module';
import { DOCKERODE } from './constants';
import { DockerService } from './docker.service';
import { TraefikConfigService } from './traefik-config.service';

// biome-ignore lint/performance/noBarrelFile: This is a module entry point
export { DOCKERODE } from './constants';

@Module({
  imports: [forwardRef(() => AppsModule)],
  providers: [
    DockerService,
    TraefikConfigService,
    {
      provide: DOCKERODE,
      useFactory: (): Dockerode => new Dockerode(),
      inject: [],
    },
  ],
  exports: [DockerService, TraefikConfigService, DOCKERODE],
})
export class DockerModule {}
