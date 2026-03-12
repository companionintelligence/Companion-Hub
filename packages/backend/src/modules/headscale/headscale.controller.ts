import { Controller, Delete, Get, Param, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { HeadscaleService } from './headscale.service';
import { ApiResponse } from '@nestjs/swagger';

@UseGuards(AuthGuard)
@Controller('headscale')
export class HeadscaleController {
  constructor(private readonly headscaleService: HeadscaleService) {}

  @Get('status')
  @ApiResponse({ type: Object })
  async getVpnStatus() {
    return this.headscaleService.getVpnStatus();
  }

  @Get('devices')
  @ApiResponse({ type: Object })
  async listDevices() {
    try {
      const devices = await this.headscaleService.listDevices();
      return { success: true, devices };
    } catch (error) {
      return {
        success: false,
        devices: [],
        error: error instanceof Error ? error.message : 'Failed to list devices',
      };
    }
  }

  @Delete('devices/:id')
  @ApiResponse({ type: Object })
  async removeDevice(@Param('id') id: string) {
    try {
      await this.headscaleService.removeDevice(id);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove device',
      };
    }
  }

  @Post('preauthkey')
  @ApiResponse({ type: Object })
  async createPreAuthKey(@Body() body: { reusable?: boolean; ephemeral?: boolean; expirationHours?: number }) {
    try {
      const key = await this.headscaleService.createPreAuthKey(body);
      return { success: true, key };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create pre-auth key',
      };
    }
  }

  @Get('preauthkeys')
  @ApiResponse({ type: Object })
  async listPreAuthKeys() {
    try {
      const keys = await this.headscaleService.listPreAuthKeys();
      return { success: true, keys };
    } catch (error) {
      return {
        success: false,
        keys: [],
        error: error instanceof Error ? error.message : 'Failed to list pre-auth keys',
      };
    }
  }
}
