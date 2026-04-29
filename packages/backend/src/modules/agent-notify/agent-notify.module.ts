import { Module } from '@nestjs/common';
import { AgentNotifyService } from './agent-notify.service';
import { AgentHealthCheckService } from './agent-health-check.service';

@Module({
  imports: [],
  providers: [AgentNotifyService, AgentHealthCheckService],
  exports: [AgentNotifyService],
})
export class AgentNotifyModule {}
