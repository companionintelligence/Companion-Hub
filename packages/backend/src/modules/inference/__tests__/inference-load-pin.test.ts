import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { CuratedModel, HardwareProfile } from '@ci-hub/common/types';

vi.mock('../../app-lifecycle/app-lifecycle.service', () => ({
  AppLifecycleService: class AppLifecycleService {},
}));
// The controller reaches the refresh service lazily; the stub class is the token the test module provides.
vi.mock('../../app-lifecycle/ai-app-inference-refresh.service', () => ({
  AiAppInferenceRefreshService: class AiAppInferenceRefreshService {},
}));

import { AiAppInferenceRefreshService } from '../../app-lifecycle/ai-app-inference-refresh.service';

import { InferenceController } from '../inference.controller';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { PoolProxyService } from '@/modules/hub-pool/hub-pool-proxy.service';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { RocmInstallerService } from '../rocm-installer.service';
import { AppCredentialsService } from '../app-credentials.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { ModelResidencyService } from '../model-residency.service';
import { BackendObserverService } from '../supervision/backend-observer.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { OmlxBackend } from '../backends/omlx.backend';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';

/**
 * `POST models/load` and `models/pin` sit behind AuthGuard, which admits only a signed-in operator
 * or a host-local credential acting as one — never an app's key. So they load with the operator's
 * rule: any idle model may be unloaded to make room, including one an app loaded.
 */
describe('InferenceController — load and pin', () => {
  let controller: InferenceController;
  let router: MockProxy<InferenceRouterService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let memoryManager: MockProxy<MemoryManagerService>;

  beforeEach(async () => {
    router = mock<InferenceRouterService>();
    modelRegistry = mock<ModelRegistryService>();
    memoryManager = mock<MemoryManagerService>();
    const hardware = mock<HardwareInspectorService>();
    hardware.getProfile.mockResolvedValue({ tier: 'high' } as HardwareProfile);
    const moduleRef = await Test.createTestingModule({
      controllers: [InferenceController],
      providers: [
        { provide: AiAppInferenceRefreshService, useValue: { requestRefresh: vi.fn() } },
        { provide: InferenceRouterService, useValue: router },
        { provide: HardwareInspectorService, useValue: hardware },
        { provide: MemoryManagerService, useValue: memoryManager },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: ModelPullerService, useValue: mock<ModelPullerService>() },
        { provide: CloudFallbackService, useValue: mock<CloudFallbackService>() },
        { provide: OllamaInstallerService, useValue: mock<OllamaInstallerService>() },
        { provide: RocmInstallerService, useValue: mock<RocmInstallerService>() },
        { provide: AppCredentialsService, useValue: mock<AppCredentialsService>() },
        { provide: DockerReadFacade, useValue: mock<DockerReadFacade>() },
        { provide: HostMetricsService, useValue: mock<HostMetricsService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: OllamaBackend, useValue: mock<OllamaBackend>() },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: OmlxBackend, useValue: mock<OmlxBackend>() },
        InferenceBackendRegistry,
        { provide: ModelResidencyService, useValue: mock<ModelResidencyService>() },
        { provide: BackendObserverService, useValue: mock<BackendObserverService>() },
        { provide: PoolProxyService, useValue: mock<PoolProxyService>() },
        { provide: HubPoolPeerService, useValue: mock<HubPoolPeerService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ApiKeyService, useValue: mock<ApiKeyService>() },
      ],
    }).compile();

    controller = moduleRef.get(InferenceController);
    modelRegistry.getCuratedModel.mockReturnValue({ runtime: { memoryFootprintMb: 8_592 } } as CuratedModel);
    memoryManager.canPinModel.mockResolvedValue({ canPin: true });
  });

  it('loads with the operator rule', async () => {
    router.loadTrackedModel.mockResolvedValue({ loaded: true });

    await expect(controller.loadModel({ modelId: 'llama3-1-8b' })).resolves.toEqual({ success: true, message: 'Model llama3-1-8b loaded' });
    expect(router.loadTrackedModel).toHaveBeenCalledWith('llama3-1-8b', { origin: 'operator' });
  });

  it("answers a refused load with the router's reason", async () => {
    router.loadTrackedModel.mockResolvedValue({ loaded: false, reason: 'llama3-1-8b is not downloaded on this node; pull it first' });

    await expect(controller.loadModel({ modelId: 'llama3-1-8b' })).resolves.toEqual({
      success: false,
      message: 'llama3-1-8b is not downloaded on this node; pull it first',
    });
  });

  // The router's pin loads first, through the same load path; its origin is what lets a REST pin clear
  // an idle model an app loaded (the router's and the fleet tests cover what it then does).
  it("pins through the router's pin, with the operator rule, and answers a refusal with its reason", async () => {
    router.pinTrackedModel.mockResolvedValue({ pinned: true });

    await expect(controller.pinModel({ modelId: 'llama3-1-8b' })).resolves.toEqual({ success: true, message: 'Model llama3-1-8b pinned' });
    expect(router.pinTrackedModel).toHaveBeenCalledWith('llama3-1-8b', { origin: 'operator' });

    router.pinTrackedModel.mockResolvedValue({ pinned: false, reason: 'gemma4:e4b is serving a request and will not be unloaded' });
    await expect(controller.pinModel({ modelId: 'llama3-1-8b' })).resolves.toEqual({
      success: false,
      message: 'gemma4:e4b is serving a request and will not be unloaded',
    });
    expect(modelRegistry.pinModel).not.toHaveBeenCalled();
  });
});
