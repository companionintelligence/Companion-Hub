import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
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
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_get_operation_status', () => {
    it('reports an in-flight operation plus the app status', async () => {
      operationRegistry.get.mockReturnValue({ requestId: 'r1', command: 'install', phase: 'pulling', tier: 'safe' } as never);
      appsService.getApp.mockResolvedValue({ app: { status: 'installing' } } as never);

      const res = await tools.getOperationStatus({ appUrn: 'nextcloud:ci-store' });
      expect(res).toMatchObject({ inFlight: true, command: 'install', phase: 'pulling', requestId: 'r1', appStatus: 'installing' });
    });

    it('is not in-flight when the requestId does not match', async () => {
      operationRegistry.get.mockReturnValue({ requestId: 'r1', command: 'install', phase: 'pulling', tier: 'safe' } as never);
      appsService.getApp.mockResolvedValue({ app: { status: 'running' } } as never);

      const res = await tools.getOperationStatus({ appUrn: 'nextcloud:ci-store', requestId: 'other' });
      expect(res).toMatchObject({ inFlight: false, appStatus: 'running' });
    });

    it('returns appStatus null when the app no longer exists', async () => {
      operationRegistry.get.mockReturnValue(undefined);
      appsService.getApp.mockRejectedValue(new Error('not found'));

      const res = await tools.getOperationStatus({ appUrn: 'gone:ci-store' });
      expect(res).toEqual({ inFlight: false, appStatus: null });
    });
  });

  describe('hub_cancel_operation', () => {
    it('delegates to AppLifecycleService.cancelOperation', async () => {
      appLifecycleService.cancelOperation.mockResolvedValue({ outcome: 'cancelling', message: 'ok' } as never);
      const res = await tools.cancelOperation({ appUrn: 'nextcloud:ci-store', requestId: 'r1' });
      expect(appLifecycleService.cancelOperation).toHaveBeenCalledWith('nextcloud:ci-store', 'r1');
      expect(res).toMatchObject({ outcome: 'cancelling' });
    });
  });
});
