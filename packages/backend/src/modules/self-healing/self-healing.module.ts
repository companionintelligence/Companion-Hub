import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { DockerModule } from '@/modules/docker/docker.module';
import { AppsModule } from '@/modules/apps/apps.module';
import { AgentNotifyModule } from '@/modules/agent-notify/agent-notify.module';
import { InferenceModule } from '@/modules/inference/inference.module';
import { SelfHealingService } from './self-healing.service';
import { SelfHealingHistoryService } from './self-healing-history.service';

@Module({
  imports: [LoggerModule, DockerModule, AppsModule, AgentNotifyModule, InferenceModule],
  providers: [SelfHealingService, SelfHealingHistoryService],
  exports: [SelfHealingService, SelfHealingHistoryService],
})
export class SelfHealingModule {}
