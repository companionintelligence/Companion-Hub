import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ActorService } from './actor.service';
import { FederationConfigService } from './federation-config.service';
import { InboxService } from './inbox.service';
import { OutboxService } from './outbox.service';

@Controller('activitypub')
export class ActivityPubController {
  constructor(
    private readonly actorService: ActorService,
    private readonly inboxService: InboxService,
    private readonly outboxService: OutboxService,
    private readonly federationConfig: FederationConfigService,
  ) {}

  private assertEnabledAndHttps(req: Request) {
    this.federationConfig.ensureEnabled();
    if (!this.federationConfig.isHttpsRequest(req)) {
      throw new BadRequestException('ActivityPub requires HTTPS');
    }
  }

  @Get('actor')
  @Header('Content-Type', 'application/activity+json')
  async getActor(@Req() req: Request) {
    this.assertEnabledAndHttps(req);
    return this.actorService.getActor(this.federationConfig.getHostFromRequest(req));
  }

  @Post('inbox')
  async inbox(@Req() req: Request, @Body() body: Record<string, unknown>) {
    this.assertEnabledAndHttps(req);
    return this.inboxService.processIncomingActivity(body, req);
  }

  @Get('outbox')
  @Header('Content-Type', 'application/activity+json')
  async outbox(@Req() req: Request) {
    this.assertEnabledAndHttps(req);
    return this.outboxService.getOutbox();
  }

  @Get('followers')
  @Header('Content-Type', 'application/activity+json')
  async followers(@Req() req: Request) {
    this.assertEnabledAndHttps(req);
    return this.outboxService.getFollowersCollection();
  }

  @Get('following')
  @Header('Content-Type', 'application/activity+json')
  async following(@Req() req: Request) {
    this.assertEnabledAndHttps(req);
    return this.outboxService.getFollowingCollection();
  }

  @Get('activities/:id')
  @Header('Content-Type', 'application/activity+json')
  async getActivity(@Req() req: Request, @Param('id') id: string) {
    this.assertEnabledAndHttps(req);
    const activity = await this.outboxService.getActivityById(id);
    if (!activity) {
      throw new NotFoundException();
    }
    return activity;
  }

  @Get('objects/:id')
  @Header('Content-Type', 'application/activity+json')
  async getObject(@Req() req: Request, @Param('id') id: string) {
    this.assertEnabledAndHttps(req);
    const object = await this.outboxService.getObjectById(id);
    if (!object) {
      throw new NotFoundException();
    }
    return object;
  }
}
