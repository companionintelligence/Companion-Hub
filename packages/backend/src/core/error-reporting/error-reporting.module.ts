import { ConfigurationModule } from '@/core/config/configuration.module';
import { Global, Module } from '@nestjs/common';
import { ErrorReportingService } from './error-reporting.service';
import { TelemetryConfigController } from './telemetry-config.controller';

@Global()
@Module({
  imports: [ConfigurationModule],
  controllers: [TelemetryConfigController],
  providers: [ErrorReportingService],
  exports: [ErrorReportingService],
})
export class ErrorReportingModule {}
