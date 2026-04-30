import { Module } from '@nestjs/common';
import { SystemModule } from '@/modules/system/system.module';
import { AgentNotifyService } from './agent-notify.service';
import { AgentHealthCheckService } from './agent-health-check.service';

@Module({
  imports: [SystemModule],
  providers: [AgentNotifyService, AgentHealthCheckService],
  exports: [AgentNotifyService],
})
export class AgentNotifyModule {}
