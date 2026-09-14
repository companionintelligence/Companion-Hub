import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LifecycleActorFor } from '@/core/portal/lifecycle-actor';
import { GRANTED_ACTOR, REFUSED_CALLERS, asGrantedOperator, lifecycleActorGate } from '@/tests/utils/lifecycle-actor-gate';
import { mcpAdminCallContext } from '../../mcp-call-context';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { OperationsTools } from '../../tools/operations.tools';
import { AppsService } from '@/modules/apps/apps.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppOperationRegistry } from '@/modules/app-lifecycle/app-operation-registry';

describe('OperationsTools', () => {
  let tools: OperationsTools;
  let operationRegistry: MockProxy<AppOperationRegistry>;
  let appLifecycleService: MockProxy<AppLifecycleService>;
  let appsService: MockProxy<AppsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperationsTools,
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
        { provide: AppOperationRegistry, useValue: mock<AppOperationRegistry>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
      ],
    }).compile();
    tools = module.get<OperationsTools>(OperationsTools);
    operationRegistry = module.get(AppOperationRegistry);
    appLifecycleService = module.get(AppLifecycleService);
    appsService = module.get(AppsService);
    // The real actor decision: the status tool asks it before it reads anything.
    appLifecycleService.assertActorMay.mockImplementation(lifecycleActorGate());
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_get_operation_status', () => {
    it('reports an in-flight operation plus the app status', async () => {
      operationRegistry.get.mockReturnValue({ requestId: 'r1', command: 'install', phase: 'pulling', tier: 'safe' } as never);
      appsService.getApp.mockResolvedValue({ app: { status: 'installing' } } as never);

      const res = await asGrantedOperator(() => tools.getOperationStatus({ appUrn: 'nextcloud:ci-store' }));
      expect(res).toMatchObject({ inFlight: true, command: 'install', phase: 'pulling', requestId: 'r1', appStatus: 'installing' });
    });

    it('is not in-flight when the requestId does not match', async () => {
      operationRegistry.get.mockReturnValue({ requestId: 'r1', command: 'install', phase: 'pulling', tier: 'safe' } as never);
      appsService.getApp.mockResolvedValue({ app: { status: 'running' } } as never);

      const res = await asGrantedOperator(() => tools.getOperationStatus({ appUrn: 'nextcloud:ci-store', requestId: 'other' }));
      expect(res).toMatchObject({ inFlight: false, appStatus: 'running' });
    });

    it('returns appStatus null when the app no longer exists', async () => {
      operationRegistry.get.mockReturnValue(undefined);
      appsService.getApp.mockRejectedValue(new Error('not found'));

      const res = await asGrantedOperator(() => tools.getOperationStatus({ appUrn: 'gone:ci-store' }));
      expect(res).toEqual({ inFlight: false, appStatus: null });
    });

    // Neither the operation registry nor the app read has a gate of its own, so the tool asks first (CI-Hub#1397).
    it.each(REFUSED_CALLERS)('refuses %s before it reads the operation or the app', async (_label, as) => {
      await expect(as(() => tools.getOperationStatus({ appUrn: 'nextcloud:ci-store' }))).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(operationRegistry.get).not.toHaveBeenCalled();
      expect(appsService.getApp).not.toHaveBeenCalled();
    });

    it('asks for view', async () => {
      appsService.getApp.mockResolvedValue({ app: { status: 'running' } } as never);

      await asGrantedOperator(() => tools.getOperationStatus({ appUrn: 'nextcloud:ci-store' }));

      expect(appLifecycleService.assertActorMay).toHaveBeenCalledWith(GRANTED_ACTOR, 'nextcloud:ci-store', 'view');
    });
  });

  describe('hub_cancel_operation', () => {
    it('delegates to AppLifecycleService.cancelOperation, as the caller, for stop', async () => {
      appLifecycleService.cancelOperation.mockResolvedValue({ outcome: 'cancelling', message: 'ok' } as never);
      const actorFor = vi.fn<LifecycleActorFor>(() => GRANTED_ACTOR);

      const res = await mcpAdminCallContext.run(actorFor, () => tools.cancelOperation({ appUrn: 'nextcloud:ci-store', requestId: 'r1' }));

      expect(actorFor).toHaveBeenCalledWith('stop');
      expect(appLifecycleService.cancelOperation).toHaveBeenCalledWith({ appUrn: 'nextcloud:ci-store', requestId: 'r1', actor: GRANTED_ACTOR });
      expect(res).toMatchObject({ outcome: 'cancelling' });
    });

    it('refuses a call that names no caller, before it reaches the service', async () => {
      await expect(tools.cancelOperation({ appUrn: 'nextcloud:ci-store' })).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(appLifecycleService.cancelOperation).not.toHaveBeenCalled();
    });
  });
});
