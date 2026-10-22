import { Global, Module } from '@nestjs/common';
import { SystemModule } from '@/modules/system/system.module';
import { AgentNotifyController } from './agent-notify.controller';
import { AgentNotifyService } from './agent-notify.service';
import { AgentHealthCheckService } from './agent-health-check.service';

/**
 * Global because wakes start in many modules (app lifecycle and status sync, backups, registration,
 * system update), whose services take the notifier as `@Optional()`. A module that could not see it
 * got `undefined` and dropped every wake silently (Companion-Hub#2081). Importing it in each of them
 * would close a cycle instead: this module imports SystemModule, which imports RegistrationModule.
 * `agent-notify.wiring.test.ts` boots AppModule and checks every injection resolves.
 */
@Global()
@Module({
  imports: [SystemModule],
  controllers: [AgentNotifyController],
  providers: [AgentNotifyService, AgentHealthCheckService],
  exports: [AgentNotifyService],
})
export class AgentNotifyModule {}
