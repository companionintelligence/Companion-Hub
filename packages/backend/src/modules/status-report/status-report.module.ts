import { Module } from '@nestjs/common';

import { AppsReadModule } from '../apps/apps-read.module';
import { InferenceModule } from '../inference/inference.module';
import { RegistrationModule } from '../registration/registration.module';
import { SystemModule } from '../system/system.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { StatusReportService } from './status-report.service';

@Module({
  imports: [AppsReadModule, InferenceModule, RegistrationModule, SystemModule, TailscaleModule],
  providers: [StatusReportService],
  exports: [StatusReportService],
})
export class StatusReportModule {}
