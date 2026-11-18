import { BadRequestException, Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { hubSessionOperatorUserId } from '@/core/portal/hub-session-operator';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { HubManagerGuard } from '@/modules/auth/hub-manager.guard';
import { AppLinkService } from './app-link.service';

interface AppLinkBody {
  consumerUrn?: unknown;
  providerUrn?: unknown;
}

function linkPair(body: AppLinkBody) {
  if (typeof body?.consumerUrn !== 'string' || typeof body?.providerUrn !== 'string') {
    throw new BadRequestException('consumerUrn and providerUrn are required');
  }
  return { consumerUrn: castAppUrn(body.consumerUrn), providerUrn: castAppUrn(body.providerUrn) };
}

/**
 * Which installed apps reach each other directly, and the operator's say over the links that wait for it.
 * See `AppLinkService` and `hub_integration.links`.
 */
@Controller('app-links')
@UseGuards(AuthGuard)
export class AppLinksController {
  constructor(private readonly links: AppLinkService) {}

  /** Every link the installed apps ask for, and whether each is in force. */
  @Get()
  list() {
    return this.links.plan();
  }

  /** Allows a link between two stores, or one only one side declared. A Hub-wide change. */
  @Post('approval')
  @UseGuards(HubManagerGuard)
  async approve(@Body() body: AppLinkBody, @Req() req: Request) {
    const { consumerUrn, providerUrn } = linkPair(body);
    try {
      return await this.links.approve(consumerUrn, providerUrn, hubSessionOperatorUserId(req) ?? null);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /** Withdraws that approval; the two apps can no longer reach each other. */
  @Delete('approval')
  @UseGuards(HubManagerGuard)
  revoke(@Body() body: AppLinkBody) {
    const { consumerUrn, providerUrn } = linkPair(body);
    return this.links.revoke(consumerUrn, providerUrn);
  }
}
