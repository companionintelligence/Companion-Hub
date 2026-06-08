import { ConfigurationModule } from '@/core/config/configuration.module';
import { Global, Module } from '@nestjs/common';
import { ErrorReportingService } from './error-reporting.service';

@Global()
@Module({
  imports: [ConfigurationModule],
  providers: [ErrorReportingService],
  exports: [ErrorReportingService],
})
export class ErrorReportingModule {}
