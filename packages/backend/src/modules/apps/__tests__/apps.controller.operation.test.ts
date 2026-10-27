/**
 * #2101: a second tab, or a page reloaded during an install's checks, showed Install again. The
 * install has no row until its checks are done, so the app read says what the Hub has under way.
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { LoggerService } from '@/core/logger/logger.service';
import type { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AppOperationRegistry } from '../../app-lifecycle/app-operation-registry';
import type { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import type { AppsReadService } from '../apps-read.service';
import type { AppsService } from '../apps.service';
import { AppsController } from '../apps.controller';

const APP_URN = 'audiomass:ci-marketplace' as never;
const OPERATOR = { hubPrincipal: 'session', user: { id: 1 } } as Request;

function controllerWith(registry: AppOperationRegistry) {
  const read = mock<AppsReadService>();
  read.getApp.mockResolvedValue({
    app: null,
    info: { id: 'audiomass', urn: APP_URN, name: 'AudioMass' },
    metadata: {},
    appDataHostPath: null,
  } as never);
  const moduleRef = mock<ModuleRef>();
  moduleRef.get.mockImplementation(((token: unknown) => (token === AppOperationRegistry ? registry : undefined)) as never);
  return new AppsController(read, mock<AppsService>(), mock<AppRuntimeMonitorService>(), moduleRef, mock<MarketplaceWhoIsService>());
}

describe('AppsController.getApp reports the operation under way', () => {
  it('names an install still in its checks, before the app has a row', async () => {
    const registry = new AppOperationRegistry(mock<LoggerService>());
    registry.beginInstallCall(APP_URN);

    const result = await controllerWith(registry).getApp(APP_URN, OPERATOR);

    expect(result.app).toBeNull();
    expect(result.operation).toEqual({ command: 'install' });
  });

  it('names a dispatched command', async () => {
    const registry = new AppOperationRegistry(mock<LoggerService>());
    registry.register(APP_URN, { requestId: 'r1', command: 'uninstall', tier: 'non_cancellable' });

    expect((await controllerWith(registry).getApp(APP_URN, OPERATOR)).operation).toEqual({ command: 'uninstall' });
  });

  it('says nothing is under way for an idle app', async () => {
    const registry = new AppOperationRegistry(mock<LoggerService>());

    expect((await controllerWith(registry).getApp(APP_URN, OPERATOR)).operation).toBeNull();
  });
});
