import { Injectable } from '@nestjs/common';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';

@Injectable()
export class CustomAppTools {
  constructor(private readonly customAppService: CustomAppService) {}

  async createCustomApp(params: { name: string; config: Record<string, unknown> }) {
    return this.customAppService.createCustomApp({ name: params.name, config: params.config } as any);
  }

  async updateCustomApp(params: { appUrn: string; config: Record<string, unknown> }) {
    await this.customAppService.updateCustomApp(castAppUrn(params.appUrn), params.config as any);
    return { success: true };
  }

  async updateAppMetadata(params: { appUrn: string; data: string }) {
    await this.customAppService.updateAppMetadata(castAppUrn(params.appUrn), params.data);
    return { success: true };
  }
}
