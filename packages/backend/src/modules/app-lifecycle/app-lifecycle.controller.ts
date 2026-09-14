import { castAppUrn } from '@/common/helpers/app-helpers';
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
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
      actor: this.whois.lifecycleActor(req, 'install'),
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
    const res = await this.appLifecycleService.installApp({ appUrn, form: body, actor: this.whois.lifecycleActor(req, 'install') });
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

  /**
   * Dry-run preview of `POST :urn/install`: the same guard checks, none of the mutation. Lets a
   * caller (UI pre-flight, future CLI `--dry-run`) show what would happen before committing.
   */
  @Post(':urn/install/plan')
  async planInstall(@Param('urn') urn: string, @Body() body: AppFormBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'install');
    return this.appLifecycleService.buildInstallPlan(appUrn, body);
  }

  @Post(':urn/start')
  @ApiResponse({ type: LifecycleRequestDto })
  async startApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'start');
    const res = await this.appLifecycleService.startApp({ appUrn, actor: this.whois.lifecycleActor(req, 'start') });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/stop')
  @ApiResponse({ type: LifecycleRequestDto })
  async stopApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'stop');
    const res = await this.appLifecycleService.stopApp({ appUrn, actor: this.whois.lifecycleActor(req, 'stop') });
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
    const res = await this.appLifecycleService.restartApp({ appUrn, actor: this.whois.lifecycleActor(req, 'restart') });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Delete(':urn/uninstall')
  @ApiResponse({ type: LifecycleRequestDto })
  async uninstallApp(@Param('urn') urn: string, @Body() body: UninstallAppBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'uninstall');
    const res = await this.appLifecycleService.uninstallApp({
      appUrn,
      deleteAllData: body.deleteAllData,
      force: body.force,
      actor: this.whois.lifecycleActor(req, 'uninstall'),
    });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/reset')
  @ApiResponse({ type: LifecycleRequestDto })
  // The route historically took no body and the schema defaults `force`, so the body is optional.
  @ApiBody({ type: ResetAppBody, required: false })
  async resetApp(@Param('urn') urn: string, @Body() body: ResetAppBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'reset');
    const res = await this.appLifecycleService.resetApp({ appUrn, force: body.force, actor: this.whois.lifecycleActor(req, 'reset') });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateApp(@Param('urn') urn: string, @Body() body: UpdateAppBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'update');
    const res = await this.appLifecycleService.updateApp({
      appUrn,
      performBackup: body.performBackup,
      actor: this.whois.lifecycleActor(req, 'update'),
    });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update-config')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateAppConfig(@Param('urn') urn: string, @Body() body: AppFormBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    const res = await this.appLifecycleService.updateAppConfig({ appUrn, form: body, actor: this.whois.lifecycleActor(req, 'configure') });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  /**
   * Cancel the in-progress (or queued) operation for an app. Returns the cancellation outcome; the
   * resulting `*_cancelled` SSE event arrives asynchronously once any compensating cleanup completes.
   * The optional `requestId` guards against cancelling a newer operation for the same app.
   */
  @Post(':urn/cancel')
  @ApiResponse({ type: CancelOperationResponseDto })
  async cancelOperation(@Param('urn') urn: string, @Body() body: CancelOperationBody, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    // Aborting somebody else's install or update is a lifecycle action like any
    // other on this controller; `stop` is the verb whose weight it matches
    // (`force-stop` next to it asserts the same one).
    await this.whois.assertSessionAction(req, appUrn, 'stop');
    const res = await this.appLifecycleService.cancelOperation({ appUrn, requestId: body.requestId, actor: this.whois.lifecycleActor(req, 'stop') });
    return CancelOperationResponseDto.parse(res, { reportOnly: true });
  }

  /*
   * Every lifecycle call names its actor through `lifecycleActor`, which refuses
   * an unrecognised principal, and the SERVICE decides from it (CI-Hub#1397).
   * The session assertions above stay — they are no longer the only check.
   */
  @Patch('update-all')
  async updateAllApps(@Req() req: Request) {
    return this.appLifecycleService.updateAllApps(this.whois.lifecycleActor(req, 'update'));
  }

  @Post('start-all')
  async startAllApps(@Req() req: Request) {
    return this.appLifecycleService.startAllApps(this.whois.lifecycleActor(req, 'start'));
  }

  @Post('stop-all')
  async stopAllApps(@Req() req: Request) {
    return this.appLifecycleService.stopAllApps(this.whois.lifecycleActor(req, 'stop'));
  }

  @Post('restart-all')
  async restartAllApps(@Req() req: Request) {
    return this.appLifecycleService.restartAllApps(this.whois.lifecycleActor(req, 'restart'));
  }
}
