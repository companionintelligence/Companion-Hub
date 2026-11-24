import { BadRequestException, Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TranslatableError } from '@/common/error/translatable-error';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { AuthGuard } from '../auth/auth.guard';
import { HubManagerGuard } from '../auth/hub-manager.guard';
import { TailscaleService } from './tailscale.service';
import { TailscaleServicesSetupBody, TailscaleServicesStatusDto, TailscaleStatusDto } from './tailscale.dto';
import { TailscaleServicesService } from './tailscale-services.service';
import { LoggerService } from '@/core/logger/logger.service';

@UseGuards(AuthGuard)
@ApiTags('Tailscale')
@Controller('tailscale')
export class TailscaleController {
  constructor(
    private readonly tailscaleService: TailscaleService,
    private readonly tailscaleServices: TailscaleServicesService,
    private readonly moduleRef: ModuleRef,
    private readonly logger: LoggerService,
  ) {}

  private async triggerTailscaleExposureSync(): Promise<void> {
    try {
      const { AppLifecycleService } = await import('../app-lifecycle/app-lifecycle.service');
      const lifecycle = this.moduleRef.get(AppLifecycleService, { strict: false });
      if (lifecycle) {
        await lifecycle.syncTailscaleExposurePublic();
      }
    } catch (error) {
      this.logger.error(`[Tailscale] Failed to sync Private VPN exposure: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  @Get('status')
  @ApiResponse({ type: TailscaleStatusDto })
  async getStatus() {
    const status = await this.tailscaleService.getStatus();
    return TailscaleStatusDto.parse({ ...status, servePermission: this.tailscaleService.getServePermission() }, { reportOnly: true });
  }

  @Post('sync')
  @UseGuards(HubManagerGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Reconcile Tailscale Serve routes for Private VPN apps' })
  @ApiResponse({ status: 200, description: 'Sync triggered' })
  async syncExposure() {
    await this.triggerTailscaleExposureSync();
    return { success: true };
  }

  @Post('auth/start')
  @UseGuards(HubManagerGuard, DemoModeGuard)
  @ApiResponse({ type: Object })
  async startAuth() {
    const cliAvailable = await this.tailscaleService.isCliAvailable();
    if (!cliAvailable) {
      throw new TranslatableError('TAILSCALE_ERROR_CLI_UNAVAILABLE');
    }

    const result = await this.tailscaleService.startAuth();
    if (result.authUrl === '') {
      await this.triggerTailscaleExposureSync();
      return { success: true, alreadyAuthenticated: true, ...(result.reconnected ? { reconnected: true } : {}) };
    }
    return { success: true, authUrl: result.authUrl };
  }

  @Post('auth/key')
  @UseGuards(HubManagerGuard, DemoModeGuard)
  @ApiResponse({ type: Object })
  async connectWithAuthKey(@Body() body: { authKey?: string }) {
    const cliAvailable = await this.tailscaleService.isCliAvailable();
    if (!cliAvailable) {
      throw new TranslatableError('TAILSCALE_ERROR_CLI_UNAVAILABLE');
    }

    await this.tailscaleService.connectWithAuthKey(body?.authKey || '');
    await this.triggerTailscaleExposureSync();
    return { success: true };
  }

  @Get('auth/check')
  @ApiResponse({ type: Object })
  async checkAuth() {
    const status = await this.tailscaleService.getStatus();
    return { authenticated: status.connected };
  }

  @Post('disconnect')
  @UseGuards(HubManagerGuard, DemoModeGuard)
  @ApiResponse({ type: Object })
  async disconnect() {
    await this.tailscaleService.disconnect();
    return { success: true };
  }

  @Get('serve')
  @ApiResponse({ type: Object })
  async getServeStatus() {
    return this.tailscaleService.getServeStatus();
  }

  @Get('services')
  @ApiOperation({ summary: 'Whether Private VPN apps are on their own Tailscale Services, and if not why' })
  @ApiResponse({ type: TailscaleServicesStatusDto })
  async getServicesStatus() {
    return TailscaleServicesStatusDto.parse(await this.tailscaleServices.status(), { reportOnly: true });
  }

  @Post('services/setup')
  @UseGuards(HubManagerGuard, DemoModeGuard)
  @ApiOperation({ summary: "Save a Tailscale OAuth client and sign the Hub's own node in as a tagged device" })
  @ApiResponse({ type: TailscaleServicesStatusDto })
  async setUpServices(@Body() body: TailscaleServicesSetupBody) {
    try {
      await this.tailscaleServices.setUp(body);
    } catch (error) {
      // Each failure says what to fix (the client, its scopes, the tag), so the page shows it as it is.
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    await this.triggerTailscaleExposureSync();
    return TailscaleServicesStatusDto.parse(await this.tailscaleServices.status(), { reportOnly: true });
  }

  @Delete('services')
  @UseGuards(HubManagerGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Stop using Tailscale Services: remove them and forget the saved OAuth client' })
  @ApiResponse({ type: TailscaleServicesStatusDto })
  async turnOffServices() {
    await this.tailscaleServices.turnOff();
    await this.triggerTailscaleExposureSync();
    return TailscaleServicesStatusDto.parse(await this.tailscaleServices.status(), { reportOnly: true });
  }
}
