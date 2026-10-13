/**
 * `GET /api/apps/:urn/compose-diff` returns the app's whole docker-compose.json. A custom app keeps its
 * env values there, typed into its form, so reading it takes `configure`, which a member does not hold on
 * a custom app. A catalog app's compose is the store's template and keeps `view`.
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import type { AppsReadService } from '../apps-read.service';
import type { AppsService } from '../apps.service';
import type { AppStartingPageService } from '../app-starting-page.service';
import type { InferenceEnvStalenessService } from '../inference-env-staleness.service';
import { AppsController } from '../apps.controller';

const req = { hubPrincipal: 'session', user: { id: 3 } } as unknown as Request;

function controllerWith(whois = mock<MarketplaceWhoIsService>()) {
  const read = mock<AppsReadService>();
  read.getAppComposeDiff.mockResolvedValue({ current: '{"services":[{"environment":[{"key":"DB_PASSWORD","value":"s3cret"}]}]}', new: null });
  const controller = new AppsController(
    read,
    mock<AppsService>(),
    mock<AppRuntimeMonitorService>(),
    mock<ModuleRef>(),
    whois,
    mock<InferenceEnvStalenessService>(),
    mock<AppStartingPageService>(),
  );
  return { controller, read, whois };
}

describe('AppsController.getAppComposeDiff', () => {
  it('asks for configure on a custom app, and reads nothing when that is refused', async () => {
    const { controller, read, whois } = controllerWith();
    whois.assertSessionAction.mockRejectedValue(new Error('APP_ACTION_GRANT_DENIED'));

    await expect(controller.getAppComposeDiff('my-compose:_user', req)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'my-compose:_user', 'configure');
    expect(read.getAppComposeDiff).not.toHaveBeenCalled();
  });

  it('keeps view for a catalog app', async () => {
    const { controller, whois } = controllerWith();

    await controller.getAppComposeDiff('immich:ci-marketplace', req);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'immich:ci-marketplace', 'view');
  });
});
