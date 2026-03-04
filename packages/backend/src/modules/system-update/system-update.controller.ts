import { Controller, Get, Post, UseGuards, Body } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { SystemUpdateService } from './system-update.service';

@Controller('system/update')
export class SystemUpdateController {
  constructor(private readonly systemUpdateService: SystemUpdateService) {}

  @Get('check')
  @UseGuards(AuthGuard)
  async checkForUpdates() {
    return this.systemUpdateService.checkForUpdates();
  }

  @Post()
  @UseGuards(AuthGuard)
  async performUpdate(@Body() body?: { targetVersion?: string }) {
    return this.systemUpdateService.performUpdate(body?.targetVersion);
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
}
