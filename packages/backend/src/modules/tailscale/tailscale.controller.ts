import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TailscaleService } from './tailscale.service';
import { ApiResponse } from '@nestjs/swagger';

@UseGuards(AuthGuard)
@Controller('tailscale')
export class TailscaleController {
  constructor(private readonly tailscaleService: TailscaleService) {}

  @Get('status')
  @ApiResponse({ type: Object })
  async getStatus() {
    return this.tailscaleService.getStatus();
  }

  @Post('auth/start')
  @ApiResponse({ type: Object })
  async startAuth() {
    const installed = await this.tailscaleService.isInstalled();
    if (!installed) {
      return {
        success: false,
        error: 'Tailscale is not installed on this device',
      };
    }

    const socketAvailable = await this.tailscaleService.isSocketAvailable();
    if (!socketAvailable) {
      return {
        success: false,
        error: 'Tailscale daemon socket is not accessible. Ensure tailscaled.sock is mounted into the container.',
      };
    }

    try {
      const result = await this.tailscaleService.startAuth();
      if (result.authUrl === '') {
        return { success: true, alreadyAuthenticated: true };
      }
      return { success: true, authUrl: result.authUrl };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start Tailscale auth',
      };
    }
  }

  @Get('auth/check')
  @ApiResponse({ type: Object })
  async checkAuth() {
    const status = await this.tailscaleService.getStatus();
    return { authenticated: status.connected };
  }

  @Post('disconnect')
  @ApiResponse({ type: Object })
  async disconnect() {
    try {
      await this.tailscaleService.disconnect();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to disconnect',
      };
    }
  }

  @Get('serve')
  @ApiResponse({ type: Object })
  async getServeStatus() {
    return this.tailscaleService.getServeStatus();
  }
}
