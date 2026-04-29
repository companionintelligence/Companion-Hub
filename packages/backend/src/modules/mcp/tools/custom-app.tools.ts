import { Injectable } from '@nestjs/common';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import type { CreateCustomAppDto, UpdateCustomAppDto } from '@/modules/custom-apps/dto/custom-apps.dto';

@Injectable()
export class CustomAppTools {
  constructor(private readonly customAppService: CustomAppService) {}

  async createCustomApp(params: { name: string; config: Record<string, unknown> }) {
    const dto: CreateCustomAppDto = { name: params.name, config: params.config };
    return this.customAppService.createCustomApp(dto);
  }

  async updateCustomApp(params: { appUrn: string; config: Record<string, unknown> }) {
    const config: UpdateCustomAppDto['config'] = params.config;
    await this.customAppService.updateCustomApp(castAppUrn(params.appUrn), config);
    return { success: true };
  }

  async updateAppMetadata(params: { appUrn: string; data: string }) {
    await this.customAppService.updateAppMetadata(castAppUrn(params.appUrn), params.data);
    return { success: true };
  }
}
