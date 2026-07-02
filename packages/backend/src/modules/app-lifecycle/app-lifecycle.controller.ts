import { castAppUrn } from '@/common/helpers/app-helpers';
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppRehydrationService } from './app-rehydration.service';
import {
  AppFormBody,
  CancelOperationBody,
  CancelOperationResponseDto,
  LifecycleRequestDto,
  UninstallAppBody,
  UpdateAppBody,
} from './dto/app-lifecycle.dto';
import { ApiResponse } from '@nestjs/swagger';

interface RehydrateBody {
  force?: boolean;
  source?: 'restore';
}

@UseGuards(AuthGuard)
@Controller('app-lifecycle')
export class AppLifecycleController {
  constructor(
    private readonly appLifecycleService: AppLifecycleService,
    private readonly appRehydrationService: AppRehydrationService,
  ) {}

  @Get('rehydrate/plan')
  async getRehydratePlan() {
    return this.appRehydrationService.buildPlan();
  }

  @Get('rehydrate/status')
  async getRehydrateStatus() {
    const [status, restoreIntent] = await Promise.all([
      this.appRehydrationService.getRehydrationStatus(),
      this.appRehydrationService.hasRestoreIntent(),
    ]);
    return { ...status, restoreIntent };
  }

  @Post('rehydrate')
  async executeRehydrate(@Body() body: RehydrateBody, @Req() req: Request) {
    return this.appRehydrationService.executeRehydrate({
      force: body.force,
      source: body.source,
      operatorUserId: req.user?.id,
    });
  }

  @Post(':urn/install')
  @ApiResponse({ type: LifecycleRequestDto })
  async installApp(@Param('urn') urn: string, @Body() body: AppFormBody) {
    const res = await this.appLifecycleService.installApp({ appUrn: castAppUrn(urn), form: body });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/start')
  @ApiResponse({ type: LifecycleRequestDto })
  async startApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.startApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/stop')
  @ApiResponse({ type: LifecycleRequestDto })
  async stopApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.stopApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/force-stop')
  @ApiResponse({ type: LifecycleRequestDto })
  async forceStopApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.forceStopApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/restart')
  @ApiResponse({ type: LifecycleRequestDto })
  async restartApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.restartApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Delete(':urn/uninstall')
  @ApiResponse({ type: LifecycleRequestDto })
  async uninstallApp(@Param('urn') urn: string, @Body() body: UninstallAppBody) {
    const res = await this.appLifecycleService.uninstallApp({ appUrn: castAppUrn(urn), deleteAllData: body.deleteAllData });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/reset')
  @ApiResponse({ type: LifecycleRequestDto })
  async resetApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.resetApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateApp(@Param('urn') urn: string, @Body() body: UpdateAppBody) {
    const res = await this.appLifecycleService.updateApp({ appUrn: castAppUrn(urn), performBackup: body.performBackup });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update-config')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateAppConfig(@Param('urn') urn: string, @Body() body: AppFormBody) {
    const res = await this.appLifecycleService.updateAppConfig({ appUrn: castAppUrn(urn), form: body });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  /**
   * Cancel the in-progress (or queued) operation for an app. Returns the cancellation outcome; the
   * resulting `*_cancelled` SSE event arrives asynchronously once any compensating cleanup completes.
   * The optional `requestId` guards against cancelling a newer operation for the same app.
   */
  @Post(':urn/cancel')
  @ApiResponse({ type: CancelOperationResponseDto })
  async cancelOperation(@Param('urn') urn: string, @Body() body: CancelOperationBody) {
    const res = await this.appLifecycleService.cancelOperation(castAppUrn(urn), body.requestId);
    return CancelOperationResponseDto.parse(res, { reportOnly: true });
  }

  @Patch('update-all')
  async updateAllApps() {
    return this.appLifecycleService.updateAllApps();
  }

  @Post('start-all')
  async startAllApps() {
    return this.appLifecycleService.startAllApps();
  }

  @Post('stop-all')
  async stopAllApps() {
    return this.appLifecycleService.stopAllApps();
  }

  @Post('restart-all')
  async restartAllApps() {
    return this.appLifecycleService.restartAllApps();
  }
}
