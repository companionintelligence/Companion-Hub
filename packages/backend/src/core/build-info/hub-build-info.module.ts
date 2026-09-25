import { Module } from '@nestjs/common';
import { HubBuildInfoController } from './hub-build-info.controller';
import { HubBuildInfoService } from './hub-build-info.service';

/**
 * Deliberately dependency-free apart from the logger. "Which build am I?" is the question an
 * operator asks when other things are broken, so this module must not be able to fail to
 * instantiate because of something unrelated.
 */
@Module({
  controllers: [HubBuildInfoController],
  providers: [HubBuildInfoService],
  exports: [HubBuildInfoService],
})
export class HubBuildInfoModule {}
