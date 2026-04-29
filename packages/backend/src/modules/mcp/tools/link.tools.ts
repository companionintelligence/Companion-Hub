import { Injectable } from '@nestjs/common';
import { LinksService } from '@/modules/links/links.service';

@Injectable()
export class LinkTools {
  constructor(private readonly linksService: LinksService) {}

  async listLinks() {
    const links = await this.linksService.getLinks(undefined);
    return { links: links ?? [] };
  }

  async createLink(params: { title: string; url: string; description?: string; iconUrl?: string; isVisibleOnGuestDashboard?: boolean }) {
    return this.linksService.add(params as any, 1);
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
    return this.linksService.edit(linkId, data as any, 1);
  }

  async deleteLink(params: { linkId: number }) {
    return this.linksService.delete(params.linkId, 1);
  }
}
