import { Injectable, type OnModuleInit } from '@nestjs/common';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { OutboxService } from '@/modules/activitypub/outbox.service';

@Injectable()
export class ActivityPubTools implements OnModuleInit {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly outboxService: OutboxService,
  ) {}

  onModuleInit() {
    this.registry.register({
      name: 'hub_get_federation_status',
      description: 'Get ActivityPub federation status, follower counts, and pending follower requests.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.outboxService.getStatus(),
    });

    this.registry.register({
      name: 'hub_post_to_fediverse',
      description: 'Publish a Note from the Hub actor to all accepted followers.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Plain-text post content to publish' },
        },
        required: ['content'],
      },
      handler: (params) => this.outboxService.publishNote(String(params.content || '')),
    });

    this.registry.register({
      name: 'hub_list_followers',
      description: 'List ActivityPub followers of this Hub.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.outboxService.listFollowers(),
    });

    this.registry.register({
      name: 'hub_list_following',
      description: 'List remote ActivityPub actors followed by this Hub.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.outboxService.listFollowing(),
    });

    this.registry.register({
      name: 'hub_follow_actor',
      description: 'Send an ActivityPub Follow request to a remote actor URL.',
      inputSchema: {
        type: 'object',
        properties: {
          actorUri: { type: 'string', description: 'Remote actor URL to follow' },
        },
        required: ['actorUri'],
      },
      handler: (params) => this.outboxService.followActor(String(params.actorUri || '')),
    });

    this.registry.register({
      name: 'hub_unfollow_actor',
      description: 'Undo a previously sent ActivityPub Follow request.',
      inputSchema: {
        type: 'object',
        properties: {
          actorUri: { type: 'string', description: 'Remote actor URL to unfollow' },
        },
        required: ['actorUri'],
      },
      handler: (params) => this.outboxService.unfollowActor(String(params.actorUri || '')),
    });

    this.registry.register({
      name: 'hub_accept_follower',
      description: 'Accept a pending ActivityPub follower.',
      inputSchema: {
        type: 'object',
        properties: {
          actorUri: { type: 'string', description: 'Remote actor URL to accept' },
        },
        required: ['actorUri'],
      },
      handler: (params) => this.outboxService.acceptFollower(String(params.actorUri || '')),
    });
  }
}
