import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
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
  async getDiagnostics(@Req() req: Request) {
    const diagnostics = await this.publicWebService.getDiagnostics();
    // The same per-app grants that gate `repair` gate seeing the drift: this report
    // carries every app's name, status, public URL and bound custom domain, so an
    // operator scoped out of an app in the installed-apps list must not read it back
    // here. `filterSessionByView` fails open on a Portal outage, so an outage cannot
    // empty the report.
    const apps = await this.whois.filterSessionByView(req, diagnostics.apps, (entry) => entry.appUrn, 'hub');
    return { apps, mismatchCount: apps.filter((entry) => entry.action === 'repair').length };
  }

  @Post('repair')
  @ApiResponse({ type: Object })
  // Sending no body repairs every drifted app, so the body stays optional.
  @ApiBody({ type: PublicWebRepairBody, required: false })
  async repair(@Req() req: Request, @Body() body?: PublicWebRepairRequest) {
    // `safeParse` + BadRequestException, not `.parse()`: a bare ZodError is not an
    // HttpException, so the exception filter would answer a malformed body with a 500
    // (and a Sentry event) where every DTO-typed route answers 400. The parameter is
    // typed with the interface rather than the DTO class so the body stays genuinely
    // optional — the global ZodValidationPipe would reject a request that sends none.
    const parsed = publicWebRepairBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    // Repair rewrites the app env and restarts the app, so it carries the same
    // grant as saving that config does — an operator who cannot configure an app
    // must not reach the same effect through the routing banner. The Portal-device
    // and CLI principals are exempt by name, so this is a no-op for them, exactly
    // as it is on every lifecycle route.
    return this.publicWebService.repair(parsed.data, async (appUrns, named) => {
      // Named apps are all-or-nothing: the operator chose them, so quietly skipping one
      // would report a repair they did not get. A sweep is filtered instead — refusing
      // it wholesale over one ungranted app would leave the operator's own drifted apps
      // permanently unrepairable.
      if (named) {
        await this.whois.assertSessionActions(req, appUrns, 'configure');
        return appUrns;
      }
      return this.whois.filterSessionByAction(req, appUrns, 'configure');
    });
  }
}
