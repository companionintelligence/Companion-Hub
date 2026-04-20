import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { RegistrationModule } from '../registration/registration.module';
import { HeadscaleController } from './headscale.controller';
import { HeadscaleService } from './headscale.service';

@Module({
  imports: [RegistrationModule, ConfigurationModule],
  controllers: [HeadscaleController],
  providers: [HeadscaleService],
  exports: [HeadscaleService],
})
export class HeadscaleModule {}
