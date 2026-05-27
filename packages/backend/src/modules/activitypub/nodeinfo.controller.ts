import { BadRequestException, Controller, Get, Header, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ActorService } from './actor.service';
import { FederationConfigService } from './federation-config.service';

@Controller()
export class NodeinfoController {
  constructor(
    private readonly actorService: ActorService,
    private readonly federationConfig: FederationConfigService,
  ) {}

  private assertEnabledAndHttps(req: Request) {
    this.federationConfig.ensureEnabled();
    if (!this.federationConfig.isHttpsRequest(req)) {
      throw new BadRequestException('ActivityPub requires HTTPS');
    }
  }

  @Get('.well-known/nodeinfo')
  @Header('Content-Type', 'application/json')
  async getNodeInfoDiscovery(@Req() req: Request) {
    this.assertEnabledAndHttps(req);
    const baseUrl = await this.federationConfig.getBaseUrl(this.federationConfig.getHostFromRequest(req));
    return {
      links: [
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
          href: `${baseUrl}/nodeinfo/2.0`,
        },
      ],
    };
  }

  @Get('nodeinfo/2.0')
  @Header('Content-Type', 'application/json')
  async getNodeInfo(@Req() req: Request) {
    this.assertEnabledAndHttps(req);
    return this.actorService.getNodeInfo(this.federationConfig.getHostFromRequest(req));
  }
}
