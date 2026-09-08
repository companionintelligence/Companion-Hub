import { castAppUrn } from '@/common/helpers/app-helpers';
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { hubSessionOperatorUserId } from '@/core/portal/hub-session-operator';
import { AuthGuard } from '../auth/auth.guard';
import { AppLifecycleService } from './app-lifecycle.service';
import { HubAccessService } from './hub-access.service';
import { AppRehydrationService } from './app-rehydration.service';
import {
  AppFormBody,
  CancelOperationBody,
  CancelOperationResponseDto,
  LifecycleRequestDto,
  ResetAppBody,
  UninstallAppBody,
  UpdateAppBody,
  ValidateConfigResultDto,
} from './dto/app-lifecycle.dto';
import { ApiBody, ApiResponse } from '@nestjs/swagger';

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
    private readonly hubAccessService: HubAccessService,
    private readonly whois: MarketplaceWhoIsService,
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

  /** Hub-provisioned trust material held by this app (managed key prefix, forward-auth state). */
  @Get(':urn/hub-access')
  async getHubAccess(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    return this.hubAccessService.getStatus(appUrn);
  }

  /** Rotate the app's Hub trust material: revoke + clear, then restart to re-provision fresh values. */
  @Post(':urn/hub-access/rotate')
  async rotateHubAccess(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    /*
     * ⚠ THIS ROTATES AN APP'S CREDENTIALS. Every install/start/stop verb beside
     * it asserts a grant and this asserted nothing, so a caller with no standing
     * over an app could revoke its managed key and forward-auth state — and the
     * app stays broken until it is restarted and re-provisioned.
     */
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return this.hubAccessService.rotate(appUrn);
  }

  @Post(':urn/install')
  @ApiResponse({ type: LifecycleRequestDto })
  async installApp(@Param('urn') urn: string, @Body() body: AppFormBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'install');
    const res = await this.appLifecycleService.installApp({ appUrn, form: body });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/validate-config')
  @ApiResponse({ type: ValidateConfigResultDto })
  async validateConfig(@Param('urn') urn: string, @Body() body: AppFormBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    const res = await this.appLifecycleService.validateAppConfig(appUrn, body);
    return ValidateConfigResultDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/start')
  @ApiResponse({ type: LifecycleRequestDto })
  async startApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'start');
    const res = await this.appLifecycleService.startApp({ appUrn });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/stop')
  @ApiResponse({ type: LifecycleRequestDto })
  async stopApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'stop');
    const res = await this.appLifecycleService.stopApp({ appUrn });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/force-stop')
  @ApiResponse({ type: LifecycleRequestDto })
  async forceStopApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'stop');
    const res = await this.appLifecycleService.forceStopApp({ appUrn });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/restart')
  @ApiResponse({ type: LifecycleRequestDto })
  async restartApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'restart');
    const res = await this.appLifecycleService.restartApp({ appUrn });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Delete(':urn/uninstall')
  @ApiResponse({ type: LifecycleRequestDto })
  async uninstallApp(@Param('urn') urn: string, @Body() body: UninstallAppBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'uninstall');
    const res = await this.appLifecycleService.uninstallApp({ appUrn, deleteAllData: body.deleteAllData, force: body.force });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/reset')
  @ApiResponse({ type: LifecycleRequestDto })
  // The route historically took no body and the schema defaults `force`, so the body is optional.
  @ApiBody({ type: ResetAppBody, required: false })
  async resetApp(@Param('urn') urn: string, @Body() body: ResetAppBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'reset');
    const res = await this.appLifecycleService.resetApp({ appUrn, force: body.force });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateApp(@Param('urn') urn: string, @Body() body: UpdateAppBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'update');
    const res = await this.appLifecycleService.updateApp({ appUrn, performBackup: body.performBackup });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update-config')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateAppConfig(@Param('urn') urn: string, @Body() body: AppFormBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    const res = await this.appLifecycleService.updateAppConfig({ appUrn, form: body });
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
  async updateAllApps(@Req() req: Request) {
    return this.appLifecycleService.updateAllApps(hubSessionOperatorUserId(req));
  }

  @Post('start-all')
  async startAllApps(@Req() req: Request) {
    return this.appLifecycleService.startAllApps(hubSessionOperatorUserId(req));
  }

  @Post('stop-all')
  async stopAllApps(@Req() req: Request) {
    return this.appLifecycleService.stopAllApps(hubSessionOperatorUserId(req));
  }

  @Post('restart-all')
  async restartAllApps(@Req() req: Request) {
    return this.appLifecycleService.restartAllApps(hubSessionOperatorUserId(req));
  }
}
