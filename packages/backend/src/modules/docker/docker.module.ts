import { Module, forwardRef } from '@nestjs/common';
import Dockerode from 'dockerode';
import { AppsModule } from '../apps/apps.module';
import { DockerService } from './docker.service';

export const DOCKERODE = 'DOCKERODE_INSTANCE';

@Module({
  imports: [forwardRef(() => AppsModule)],
  providers: [
    DockerService,
    {
      provide: DOCKERODE,
      useFactory: (): Dockerode => new Dockerode(),
      inject: [],
    },
  ],
  exports: [DockerService, DOCKERODE],
})
export class DockerModule {}
