import { Injectable } from '@nestjs/common';
import { UserConfigService } from '@/modules/user-config/user-config.service';
import { AppsService } from '@/modules/apps/apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';

@Injectable()
export class AppConfigTools {
  constructor(
    private readonly userConfigService: UserConfigService,
    private readonly appsService: AppsService,
  ) {}

  async getUserConfig(params: { appUrn: string }) {
    return this.userConfigService.getUserConfig(castAppUrn(params.appUrn));
  }

  async updateUserConfig(params: { appUrn: string; dockerCompose: string; appEnv: string }) {
    await this.userConfigService.updateUserConfig(castAppUrn(params.appUrn), {
      dockerCompose: params.dockerCompose,
      appEnv: params.appEnv,
    });
    return { success: true };
  }

  async enableUserConfig(params: { appUrn: string }) {
    await this.userConfigService.enableUserConfig(castAppUrn(params.appUrn));
    return { success: true };
  }

  async disableUserConfig(params: { appUrn: string }) {
    await this.userConfigService.disableUserConfig(castAppUrn(params.appUrn));
    return { success: true };
  }

  async ignoreAppVersion(params: { appUrn: string }) {
    return this.appsService.ignoreAppVersion(castAppUrn(params.appUrn));
  }

  async unignoreAppVersion(params: { appUrn: string }) {
    return this.appsService.unignoreAppVersion(castAppUrn(params.appUrn));
  }
}
