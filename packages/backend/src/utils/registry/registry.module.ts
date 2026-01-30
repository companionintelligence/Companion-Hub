import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { RegistryService } from './registry.service';

@Module({
  imports: [HttpModule, ConfigurationModule, LoggerModule],
  providers: [RegistryService],
  exports: [RegistryService],
})
export class RegistryModule {}
