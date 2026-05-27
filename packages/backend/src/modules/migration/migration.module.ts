import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { InferenceModule } from '@/modules/inference/inference.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';

@Module({
  imports: [LoggerModule, InferenceModule],
  controllers: [MigrationController],
  providers: [MigrationService],
  exports: [MigrationService],
})
export class MigrationModule {}
