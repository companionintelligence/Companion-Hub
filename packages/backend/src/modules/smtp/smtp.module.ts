import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { SmtpService } from './smtp.service';
import { SmtpRegistryService } from './smtp-registry.service';
import { SmtpInjectorService } from './smtp-injector.service';
import { SmtpDnsService } from './smtp-dns.service';

@Module({
  imports: [LoggerModule],
  providers: [SmtpService, SmtpRegistryService, SmtpInjectorService, SmtpDnsService],
  exports: [SmtpService, SmtpRegistryService, SmtpInjectorService, SmtpDnsService],
})
export class SmtpModule {}
