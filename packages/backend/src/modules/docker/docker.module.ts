import { Module, forwardRef } from '@nestjs/common';
import Dockerode from 'dockerode';
import { AppsModule } from '../apps/apps.module';
import { DockerService } from './docker.service';
import { TraefikConfigService } from './traefik-config.service';

export const DOCKERODE = 'DOCKERODE_INSTANCE';

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
