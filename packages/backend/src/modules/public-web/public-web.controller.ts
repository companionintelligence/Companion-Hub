import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import { PublicWebService, type PublicWebRepairRequest } from './public-web.service';
import { PublicWebRepairBody, publicWebRepairBodySchema } from './public-web.dto';

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
  // Sending no body repairs every drifted app, so the body stays optional.
  @ApiBody({ type: PublicWebRepairBody, required: false })
  async repair(@Body() body?: PublicWebRepairRequest) {
    const parsed = publicWebRepairBodySchema.parse(body ?? {});
    return this.publicWebService.repair(parsed);
  }
}
