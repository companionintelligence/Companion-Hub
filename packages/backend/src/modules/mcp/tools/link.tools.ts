import { Injectable } from '@nestjs/common';
import { LinksService } from '@/modules/links/links.service';
import type { LinkBodyDto, EditLinkBodyDto } from '@/modules/links/dto/links.dto';

@Injectable()
export class LinkTools {
  constructor(private readonly linksService: LinksService) {}

  async listLinks() {
    const links = await this.linksService.getLinks(undefined);
    return { links: links ?? [] };
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
