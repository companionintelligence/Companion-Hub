import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ApiResponse } from '@nestjs/swagger';
import { PublicWebService, type PublicWebRepairRequest } from './public-web.service';
import { z } from 'zod';
import { zodAppUrn } from '@ci-hub/common/types';

const repairBodySchema = z.object({
  appUrns: z.array(zodAppUrn).optional(),
});

@UseGuards(AuthGuard)
@Controller('public-web')
export class PublicWebController {
  constructor(private readonly publicWebService: PublicWebService) {}

  @Get('diagnostics')
  @ApiResponse({ type: Object })
  async getDiagnostics() {
    return this.publicWebService.getDiagnostics();
  }

  @Post('repair')
  @ApiResponse({ type: Object })
  async repair(@Body() body?: PublicWebRepairRequest) {
    const parsed = repairBodySchema.parse(body ?? {});
    return this.publicWebService.repair(parsed);
  }
}
