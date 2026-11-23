import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { AppsReadModule } from '@/modules/apps/apps-read.module';
import { DockerModule } from '@/modules/docker/docker.module';
import { AppLinkApprovalRepository } from './app-link-approval.repository';
import { AppLinkService } from './app-link.service';
import { AppLinksController } from './app-links.controller';

/** The networks that link one app to another (`AppLinkService`), and the operator's approvals of them. */
@Module({
  imports: [LoggerModule, DockerModule, AppsReadModule],
  controllers: [AppLinksController],
  providers: [AppLinkApprovalRepository, AppLinkService],
  exports: [AppLinkService],
})
export class AppLinksModule {}
