import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LinksService } from '@/modules/links/links.service';
import type { LinkBodyDto, EditLinkBodyDto } from '@/modules/links/dto/links.dto';
import { McpToolRegistry } from '../mcp-tool-registry.service';

@Injectable()
export class LinkTools implements OnModuleInit {
  constructor(
    private readonly linksService: LinksService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      name: 'hub_list_links',
      description: 'List all dashboard links.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listLinks(),
    });
    this.registry.register({
      name: 'hub_create_link',
      description: 'Create a new dashboard link. Returns the created link.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Link title (1-20 chars)' },
          url: { type: 'string', description: 'Link URL' },
          description: { type: 'string', description: 'Short description (max 50 chars)' },
          iconUrl: { type: 'string', description: 'Icon URL' },
          isVisibleOnGuestDashboard: { type: 'boolean', description: 'Show on guest dashboard (default false)' },
        },
        required: ['title', 'url'],
      },
      handler: (p) =>
        this.createLink(p as { title: string; url: string; description?: string; iconUrl?: string; isVisibleOnGuestDashboard?: boolean }),
    });
    this.registry.register({
      name: 'hub_edit_link',
      description: 'Update an existing dashboard link.',
      inputSchema: {
        type: 'object',
        properties: {
          linkId: { type: 'number', description: 'Link ID to edit' },
          title: { type: 'string', description: 'New title' },
          url: { type: 'string', description: 'New URL' },
          description: { type: 'string', description: 'New description' },
          iconUrl: { type: 'string', description: 'New icon URL' },
          isVisibleOnGuestDashboard: { type: 'boolean', description: 'Guest dashboard visibility' },
        },
        required: ['linkId'],
      },
      handler: (p) =>
        this.editLink(
          p as { linkId: number; title?: string; url?: string; description?: string; iconUrl?: string; isVisibleOnGuestDashboard?: boolean },
        ),
    });
    this.registry.register({
      name: 'hub_delete_link',
      destructive: true, // ISSUE-MCP-2: permanently deletes a dashboard link.
      description: 'Delete a dashboard link by ID.',
      inputSchema: { type: 'object', properties: { linkId: { type: 'number', description: 'Link ID to delete' } }, required: ['linkId'] },
      handler: (p) => this.deleteLink(p as { linkId: number }),
    });
  }

  async listLinks() {
    return { links: (await this.linksService.getLinks(undefined)) ?? [] };
  }
  async createLink(params: { title: string; url: string; description?: string; iconUrl?: string; isVisibleOnGuestDashboard?: boolean }) {
    const dto: LinkBodyDto = {
      title: params.title,
      url: params.url,
      description: params.description,
      iconUrl: params.iconUrl,
      isVisibleOnGuestDashboard: params.isVisibleOnGuestDashboard ?? false,
    };
    return this.linksService.add(dto, 1);
  }
  async editLink(params: {
    linkId: number;
    title?: string;
    url?: string;
    description?: string;
    iconUrl?: string;
    isVisibleOnGuestDashboard?: boolean;
  }) {
    const { linkId, ...data } = params;
    const dto: EditLinkBodyDto = {
      title: data.title ?? '',
      url: data.url ?? '',
      description: data.description,
      iconUrl: data.iconUrl,
      isVisibleOnGuestDashboard: data.isVisibleOnGuestDashboard,
    };
    return this.linksService.edit(linkId, dto, 1);
  }
  async deleteLink(params: { linkId: number }) {
    return this.linksService.delete(params.linkId, 1);
  }
}
