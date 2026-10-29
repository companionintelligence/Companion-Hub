import { BadRequestException, Controller, Get, Param, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('KERI / Trust Over IP')
@Controller()
export class OobiController {
  @Get('.well-known/keri/oobi')
  @ApiOperation({ summary: 'KERI Out-Of-Band Introduction (OOBI) metadata for the Hub appliance' })
  @ApiResponse({
    status: 503,
    description: 'The Hub cannot publish a verifiable OOBI until a persisted KERI key event log is configured.',
  })
  getHubOobi(): never {
    throw new ServiceUnavailableException('KERI OOBI publication is unavailable until this Hub has a persisted key event log.');
  }

  @Get('.well-known/keri/oobi/:aid')
  @ApiOperation({ summary: 'Resolve OOBI for a specific AID' })
  @ApiResponse({
    status: 503,
    description: 'The Hub cannot resolve OOBIs until it can verify and serve persisted KERI key event logs.',
  })
  getOobiForAid(@Param('aid') aid: string): never {
    if (!aid.trim()) {
      throw new BadRequestException('AID is required.');
    }
    throw new ServiceUnavailableException('KERI OOBI resolution is unavailable until this Hub can verify and serve persisted key event logs.');
  }
}
