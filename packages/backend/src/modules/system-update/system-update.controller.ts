import { BadRequestException, Controller, Get, Post, Query, UseGuards, Body } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { DesktopReleaseService } from './desktop-release.service';
import { DesktopReleaseDto, DesktopReleaseQueryDto } from './dto/desktop-release.dto';
import { HUB_VERSION_TAG_MESSAGE, isHubVersionTag } from './hub-deployment';
import { SystemUpdateService } from './system-update.service';

@Controller('system/update')
export class SystemUpdateController {
  constructor(
    private readonly systemUpdateService: SystemUpdateService,
    private readonly desktopReleaseService: DesktopReleaseService,
  ) {}

  @Get('check')
  @UseGuards(AuthGuard)
  async checkForUpdates() {
    return this.systemUpdateService.checkForUpdates();
  }

  @Post()
  @UseGuards(AuthGuard)
  async performUpdate(@Body() body?: { targetVersion?: string }) {
    const targetVersion: unknown = body?.targetVersion;
    // The service checks again for its other callers (MCP, auto-update). Refusing here keeps a
    // bad request from reaching any update work.
    if (targetVersion !== undefined && (typeof targetVersion !== 'string' || !isHubVersionTag(targetVersion.trim()))) {
      throw new BadRequestException(HUB_VERSION_TAG_MESSAGE);
    }
    return this.systemUpdateService.performUpdate(targetVersion);
  }

  @Get('auto-updates')
  @UseGuards(AuthGuard)
  getAutoUpdates() {
    return { enabled: this.systemUpdateService.getAutoUpdatesEnabled() };
  }

  @Post('auto-updates')
  @UseGuards(AuthGuard)
  async setAutoUpdates(@Body() body: { enabled: boolean }) {
    await this.systemUpdateService.setAutoUpdatesEnabled(body.enabled);
    return { enabled: body.enabled };
  }

  @Get('host-listener')
  @UseGuards(AuthGuard)
  async getHostListenerStatus() {
    return this.systemUpdateService.getHostListenerStatus();
  }

  /** The newest desktop app and its installer for one platform, for a browser that cannot read the download servers. */
  @Get('desktop-release')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: DesktopReleaseDto })
  async getDesktopRelease(@Query() query: DesktopReleaseQueryDto) {
    return this.desktopReleaseService.getDesktopRelease(query);
  }
}
