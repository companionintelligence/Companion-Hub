import { castAppUrn } from '@/common/helpers/app-helpers';
import { Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ModuleRef } from '@nestjs/core';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AuthGuard } from '../auth/auth.guard';
import { ObservabilityRead, ObservabilityReadGuard } from '../auth/observability-read.guard';
import { AppRuntimeMonitorService } from './app-runtime-monitor.service';
import { AppsReadService } from './apps-read.service';
import { AppsService } from './apps.service';
import {
  AppDataListingDto,
  GetAppDto,
  GetComposeDiffDto,
  GetConfigDiffDto,
  GetRandomPortDto,
  GuestAppsDto,
  InstalledAppUrnsDto,
  MyAppsDto,
  UpdatesAvailableDto,
} from './dto/app.dto';
import { InstallQueueDto } from './dto/install-queue.dto';
import { AppRuntimeHealthDto, AppRuntimeMonitorDto } from './dto/runtime-health.dto';
import { ApiResponse } from '@nestjs/swagger';
import { buildMcpInstallSchema } from '@ci-hub/common/validation';
import type { AppUrn } from '@ci-hub/common/types';

@Controller('apps')
export class AppsController {
  constructor(
    private readonly appsReadService: AppsReadService,
    private readonly appsService: AppsService,
    private readonly runtimeMonitor: AppRuntimeMonitorService,
    private readonly moduleRef: ModuleRef,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  @Get('installed')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: MyAppsDto })
  async getInstalledApps(@Req() req: Request) {
    const installed = await this.appsReadService.getInstalledApps();
    const visible = await this.whois.filterSessionByView(req, installed, (item) => item.info?.urn, 'hub');
    return MyAppsDto.parse({ installed: visible }, { reportOnly: true });
  }

  /** Lightweight URN set for store "installed" badges — no FS/compose populate. */
  @Get('installed-urns')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: InstalledAppUrnsDto })
  async getInstalledAppUrns(@Req() req: Request) {
    const urns = await this.appsReadService.getInstalledAppUrns();
    const visible = await this.whois.filterSessionByView(req, urns, (urn) => urn, 'hub');
    return InstalledAppUrnsDto.parse({ urns: visible }, { reportOnly: true });
  }

  /** Deferred update badge — not on the critical `/api/app-context` path. */
  @Get('updates-available')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: UpdatesAvailableDto })
  async getUpdatesAvailable() {
    const updatesAvailable = await this.appsReadService.getUpdatesAvailableCached();
    return UpdatesAvailableDto.parse({ updatesAvailable }, { reportOnly: true });
  }

  /** Readable by a `qa:read` key: an install journey polls this until its app is running or has failed. */
  @Get('install-queue')
  @UseGuards(ObservabilityReadGuard)
  @ObservabilityRead()
  @ApiResponse({ type: InstallQueueDto })
  async getInstallQueue(@Req() req: Request) {
    const queue = await this.appsReadService.getInstallQueueState();
    // Names and URNs of apps somebody else is installing, on a route that sits
    // between two that already filter. `filterSessionByView` fails open on an
    // unresolved grant, so an outage still shows the queue.
    const entries = queue.active ? [queue.active, ...queue.queued] : queue.queued;
    const visible = new Set(await this.whois.filterSessionByView(req, entries, (entry) => entry.urn, 'hub'));
    return InstallQueueDto.parse(
      {
        active: queue.active && visible.has(queue.active) ? queue.active : null,
        queued: queue.queued.filter((entry) => visible.has(entry)),
      },
      { reportOnly: true },
    );
  }

  @Get('guest')
  @ApiResponse({ type: GuestAppsDto })
  async getGuestApps() {
    const guest = await this.appsReadService.getGuestDashboardApps();
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

  /**
   * Readable by a `qa:read` key, for an app's install status — but without `app.config`.
   *
   * `config` is the form the operator filled in at install: admin passwords, provider API keys,
   * anything a manifest asks for. A test polling for `running` needs none of it, and a leaked test key
   * must not be a way to read every app's secrets, so it is removed for that principal rather than the
   * route being opened as it is.
   */
  @Get(':urn')
  @UseGuards(ObservabilityReadGuard)
  @ObservabilityRead()
  @ApiResponse({ type: GetAppDto })
  async getApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    const res = await this.appsReadService.getApp(appUrn);
    const mcpExtras = await this.buildMcpExtras(appUrn, res.info);
    const app = req.hubPrincipal === 'qa-read' && res.app ? { ...res.app, config: undefined } : res.app;
    return GetAppDto.parse({ ...res, app, ...mcpExtras }, { reportOnly: true });
  }

  private async buildMcpExtras(appUrn: AppUrn, info: { mcp?: unknown }) {
    if (!info.mcp) {
      return { mcpInstallSchema: null, mcpRuntime: null };
    }
    // Lazy ModuleRef + dynamic import avoids AppsModule → McpModule Nest import.
    let mcpRuntime: unknown = null;
    try {
      const { McpProbeService } = await import('../mcp/mcp-probe.service');
      const probe = this.moduleRef.get(McpProbeService, { strict: false });
      mcpRuntime = probe?.getCached(appUrn) ?? null;
    } catch {
      mcpRuntime = null;
    }
    return {
      mcpInstallSchema: buildMcpInstallSchema(info as Parameters<typeof buildMcpInstallSchema>[0]),
      mcpRuntime,
    };
  }

  /** Read-only file inventory for the web "Open data folder" dialog. */
  @Get(':urn/data-files')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AppDataListingDto })
  async getAppDataListing(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    // Every other `:urn` route on this controller asserts the operator's grant over
    // the named app; this one listed any app's data tree on the AuthGuard alone.
    await this.whois.assertSessionAction(req, appUrn, 'view');
    const res = await this.appsReadService.getAppDataListing(appUrn);
    return AppDataListingDto.parse(res, { reportOnly: true });
  }

  @Get(':urn/compose-diff')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: GetComposeDiffDto })
  async getAppComposeDiff(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    const res = await this.appsReadService.getAppComposeDiff(appUrn);
    return GetComposeDiffDto.parse(res, { reportOnly: true });
  }

  @Get(':urn/config-diff')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: GetConfigDiffDto })
  async getAppConfigDiff(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    const res = await this.appsReadService.getAppConfigDiff(appUrn);
    return GetConfigDiffDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/ignore-version')
  @UseGuards(AuthGuard)
  async ignoreAppVersion(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    // Writes app state: suppressing an update notice is a configuration choice
    // about somebody else's app.
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return this.appsService.ignoreAppVersion(appUrn);
  }

  @Patch(':urn/unignore-version')
  @UseGuards(AuthGuard)
  async unignoreAppVersion(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return this.appsService.unignoreAppVersion(appUrn);
  }

  @Get(':urn/check-availability')
  @UseGuards(AuthGuard)
  async checkAvailability(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    return this.appsService.checkAppAvailability(appUrn);
  }

  @Get(':urn/runtime-health')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AppRuntimeHealthDto })
  async getRuntimeHealth(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    const snapshot = await this.runtimeMonitor.getAppRuntimeHealth(appUrn);
    return AppRuntimeHealthDto.parse(snapshot, { reportOnly: true });
  }

  @Post(':urn/resolve-availability')
  @UseGuards(AuthGuard)
  async resolveAvailability(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return this.appsService.resolveAppAvailability(appUrn);
  }
}
