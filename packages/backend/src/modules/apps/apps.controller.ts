import { castAppUrn } from '@/common/helpers/app-helpers';
import { Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AppRuntimeMonitorService } from './app-runtime-monitor.service';
import { AppsService } from './apps.service';
import { GetAppDto, GetComposeDiffDto, GetConfigDiffDto, GetRandomPortDto, GuestAppsDto, MyAppsDto } from './dto/app.dto';
import { InstallQueueDto } from './dto/install-queue.dto';
import { AppRuntimeHealthDto, AppRuntimeMonitorDto } from './dto/runtime-health.dto';
import { ApiResponse } from '@nestjs/swagger';

@Controller('apps')
export class AppsController {
  constructor(
    private readonly appsService: AppsService,
    private readonly runtimeMonitor: AppRuntimeMonitorService,
  ) {}

  @Get('installed')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: MyAppsDto })
  async getInstalledApps() {
    const installed = await this.appsService.getInstalledApps();
    return MyAppsDto.parse({ installed }, { reportOnly: true });
  }

  @Get('install-queue')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: InstallQueueDto })
  async getInstallQueue() {
    const queue = await this.appsService.getInstallQueueState();
    return InstallQueueDto.parse(queue, { reportOnly: true });
  }

  @Get('guest')
  @ApiResponse({ type: GuestAppsDto })
  async getGuestApps() {
    const guest = await this.appsService.getGuestDashboardApps();
    return GuestAppsDto.parse({ installed: guest }, { reportOnly: true });
  }

  @Post('random-port')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: GetRandomPortDto })
  async getRandomPort() {
    const port = await this.appsService.getRandomPort();
    return GetRandomPortDto.parse({ port }, { reportOnly: true });
  }

  @Get('resource-monitor')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AppRuntimeMonitorDto })
  async getResourceMonitor() {
    const snapshot = await this.runtimeMonitor.getRuntimeMonitorSnapshot();
    return AppRuntimeMonitorDto.parse(snapshot, { reportOnly: true });
  }

  @Get(':urn')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: GetAppDto })
  async getApp(@Param('urn') urn: string) {
    const res = await this.appsService.getApp(castAppUrn(urn));
    return GetAppDto.parse(res, { reportOnly: true });
  }

  @Get(':urn/compose-diff')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: GetComposeDiffDto })
  async getAppComposeDiff(@Param('urn') urn: string) {
    const res = await this.appsService.getAppComposeDiff(castAppUrn(urn));
    return GetComposeDiffDto.parse(res, { reportOnly: true });
  }

  @Get(':urn/config-diff')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: GetConfigDiffDto })
  async getAppConfigDiff(@Param('urn') urn: string) {
    const res = await this.appsService.getAppConfigDiff(castAppUrn(urn));
    return GetConfigDiffDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/ignore-version')
  @UseGuards(AuthGuard)
  async ignoreAppVersion(@Param('urn') urn: string) {
    return this.appsService.ignoreAppVersion(castAppUrn(urn));
  }

  @Patch(':urn/unignore-version')
  @UseGuards(AuthGuard)
  async unignoreAppVersion(@Param('urn') urn: string) {
    return this.appsService.unignoreAppVersion(castAppUrn(urn));
  }

  @Get(':urn/check-availability')
  @UseGuards(AuthGuard)
  async checkAvailability(@Param('urn') urn: string) {
    return this.appsService.checkAppAvailability(castAppUrn(urn));
  }

  @Get(':urn/runtime-health')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AppRuntimeHealthDto })
  async getRuntimeHealth(@Param('urn') urn: string) {
    const snapshot = await this.runtimeMonitor.getAppRuntimeHealth(castAppUrn(urn));
    return AppRuntimeHealthDto.parse(snapshot, { reportOnly: true });
  }

  @Post(':urn/resolve-availability')
  @UseGuards(AuthGuard)
  async resolveAvailability(@Param('urn') urn: string) {
    return this.appsService.resolveAppAvailability(castAppUrn(urn));
  }
}
