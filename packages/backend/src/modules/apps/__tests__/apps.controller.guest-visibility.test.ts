/**
 * `PATCH /api/apps/:urn/guest-visibility` (#2422) shows or hides one app on the guest dashboard from
 * Settings. It changes what the app's Settings dialog changes, so it asks for the same grant.
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

function controllerWith() {
  const whois = mock<MarketplaceWhoIsService>();
  const apps = mock<AppsService>();
  const controller = new AppsController(
    mock<AppsReadService>(),
    apps,
    mock<AppRuntimeMonitorService>(),
    mock<ModuleRef>(),
    whois,
    mock<InferenceEnvStalenessService>(),
    mock<AppStartingPageService>(),
  );
  return { controller, apps, whois };
}

describe('AppsController.setGuestVisibility', () => {
  it('asks for configure on the app, then saves the choice', async () => {
    const { controller, apps, whois } = controllerWith();

    await controller.setGuestVisibility('immich:ci-marketplace', { visible: true }, req);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'immich:ci-marketplace', 'configure');
    expect(apps.setGuestVisibility).toHaveBeenCalledWith('immich:ci-marketplace', true);
  });

  it('saves nothing for someone the grant turns away', async () => {
    const { controller, apps, whois } = controllerWith();
    whois.assertSessionAction.mockRejectedValue(new Error('APP_ACTION_GRANT_DENIED'));

    await expect(controller.setGuestVisibility('immich:ci-marketplace', { visible: true }, req)).rejects.toThrow('APP_ACTION_GRANT_DENIED');
    expect(apps.setGuestVisibility).not.toHaveBeenCalled();
  });
});
