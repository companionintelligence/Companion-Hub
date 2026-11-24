import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { settingsReadAction } from '@/core/portal/local-app-reads';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { GetUserConfigDto, UpdateUserConfigDto } from './dto/user-config.dto';
import { UserConfigService } from './user-config.service';

/**
 * An app's user config is a compose override and env values laid over the app's own. These routes
 * asked for nothing but a sign-in, while their MCP tools asked for the app's grant. They now assert
 * the same verbs for the session: reading takes what reading the app's settings takes
 * (`settingsReadAction`: `view` on a catalog app, `configure` on a custom app), and every change takes
 * `configure`.
 */
@Controller('user-config')
@ApiTags('User Config')
@UseGuards(AuthGuard)
export class UserConfigController {
  constructor(
    private readonly userConfigService: UserConfigService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  @Get(':urn')
  @ApiOperation({ summary: 'Get the user configuration for an app' })
  @ApiResponse({ type: GetUserConfigDto })
  async getUserConfig(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, settingsReadAction(appUrn));
    const res = await this.userConfigService.getUserConfig(appUrn);
    return GetUserConfigDto.parse(res, { reportOnly: true });
  }

  @Put(':urn')
  @ApiOperation({ summary: 'Update the user configuration for an app' })
  async updateUserConfig(@Param('urn') urn: string, @Body() updateUserConfigDto: UpdateUserConfigDto, @Req() req: Request): Promise<void> {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return this.userConfigService.updateUserConfig(appUrn, updateUserConfigDto);
  }

  @Post(':urn/enable')
  @ApiOperation({ summary: 'Enable the user configuration for an app' })
  async enableUserConfig(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return this.userConfigService.enableUserConfig(appUrn);
  }

  @Post(':urn/disable')
  @ApiOperation({ summary: 'Disable the user configuration for an app' })
  async disableUserConfig(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return this.userConfigService.disableUserConfig(appUrn);
  }
}
