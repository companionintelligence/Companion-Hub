import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TranslatableError } from '@/common/error/translatable-error';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { AuthGuard } from '../auth/auth.guard';
import { TailscaleService } from './tailscale.service';
import { LoggerService } from '@/core/logger/logger.service';

@UseGuards(AuthGuard)
@ApiTags('Tailscale')
@Controller('tailscale')
export class TailscaleController {
  constructor(
    private readonly tailscaleService: TailscaleService,
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
  @ApiResponse({ type: Object })
  async getStatus() {
    return this.tailscaleService.getStatus();
  }

  @Post('sync')
  @UseGuards(DemoModeGuard)
  @ApiOperation({ summary: 'Reconcile Tailscale Serve routes for Private VPN apps' })
  @ApiResponse({ status: 200, description: 'Sync triggered' })
  async syncExposure() {
    await this.triggerTailscaleExposureSync();
    return { success: true };
  }

  @Post('auth/start')
  @UseGuards(DemoModeGuard)
  @ApiResponse({ type: Object })
  async startAuth() {
    const cliAvailable = await this.tailscaleService.isCliAvailable();
    if (!cliAvailable) {
      throw new TranslatableError('TAILSCALE_ERROR_CLI_UNAVAILABLE');
    }

    const result = await this.tailscaleService.startAuth();
    if (result.authUrl === '') {
      await this.triggerTailscaleExposureSync();
      return { success: true, alreadyAuthenticated: true };
    }
    return { success: true, authUrl: result.authUrl };
  }

  @Post('auth/key')
  @UseGuards(DemoModeGuard)
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
    if (status.connected) {
      // Browser sign-in completes out-of-band (the user finishes on the
      // Tailscale site), so this poll is the first place the Hub can see the
      // connection land. Reconcile serve state here — fire-and-forget, the
      // reconcile is idempotent — so the Hub and Private VPN apps get published
      // without waiting for the next app lifecycle event.
      void this.triggerTailscaleExposureSync();
    }
    return { authenticated: status.connected };
  }

  @Post('disconnect')
  @UseGuards(DemoModeGuard)
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
}
