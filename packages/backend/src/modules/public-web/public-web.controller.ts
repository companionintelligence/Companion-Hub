import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { PublicWebService, type PublicWebRepairRequest } from './public-web.service';
import { PublicWebRepairBody, publicWebRepairBodySchema } from './public-web.dto';

@UseGuards(AuthGuard)
@Controller('public-web')
export class PublicWebController {
  constructor(
    private readonly publicWebService: PublicWebService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  @Get('diagnostics')
  @ApiResponse({ type: Object })
  async getDiagnostics() {
    return this.publicWebService.getDiagnostics();
  }

  @Post('repair')
  @ApiResponse({ type: Object })
  // Sending no body repairs every drifted app, so the body stays optional.
  @ApiBody({ type: PublicWebRepairBody, required: false })
  async repair(@Req() req: Request, @Body() body?: PublicWebRepairRequest) {
    const parsed = publicWebRepairBodySchema.parse(body ?? {});
    // Repair rewrites the app env and restarts the app, so it carries the same
    // grant as saving that config does — an operator who cannot configure an app
    // must not reach the same effect through the routing banner. API-key callers
    // (the `cihub` CLI) hold no Hub session, so this is a no-op for them, exactly
    // as it is on every lifecycle route.
    return this.publicWebService.repair(parsed, (appUrn) => this.whois.assertSessionAction(req, appUrn, 'configure'));
  }
}
