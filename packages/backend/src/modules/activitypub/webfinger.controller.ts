import { BadRequestException, Controller, Get, Header, NotFoundException, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { FederationConfigService } from './federation-config.service';

@Controller('.well-known')
export class WebfingerController {
  constructor(private readonly federationConfig: FederationConfigService) {}

  @Get('webfinger')
  @Header('Content-Type', 'application/jrd+json')
  async getWebfinger(@Req() req: Request, @Query('resource') resource: string) {
    this.federationConfig.ensureEnabled();
    if (!this.federationConfig.isHttpsRequest(req)) {
      throw new BadRequestException('ActivityPub requires HTTPS');
    }

    const host = this.federationConfig.getHostFromRequest(req);
    const baseUrl = await this.federationConfig.getBaseUrl(host);
    const preferredUsername = this.federationConfig.getSettings().federationPreferredUsername;
    const expectedResource = `acct:${preferredUsername}@${host}`;
    if (resource !== expectedResource) {
      throw new NotFoundException();
    }

    return {
      subject: expectedResource,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: `${baseUrl}/api/activitypub/actor`,
        },
      ],
    };
  }
}
