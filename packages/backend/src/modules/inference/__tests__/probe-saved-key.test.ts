import { Test } from '@nestjs/testing';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HardwareProfile, InferenceStatus } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { PoolProxyService } from '@/modules/hub-pool/hub-pool-proxy.service';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { InferenceController } from '../inference.controller';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
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
import { OMLX_CUDA_HELPER_PAIRING_COMMAND, OMLX_CUDA_HELPER_RUN_COMMAND, OmlxBackend } from '../backends/omlx.backend';

// Only `get` is faked, so every probe the real backends make is recorded with the headers it sent.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, get: vi.fn() } };
});

const get = vi.mocked(axios.get);

const SAVED_VLLM_URL = 'http://gpu-box.lan:8000';
const SAVED_OMLX_URL = 'http://mac-studio.lan:8000';
const LISTENER = 'http://listener.example:9999';

/**
 * The three Re-check routes with the REAL vLLM and oMLX backends behind them, so the assertion is
 * on the request that leaves the Hub. Each route takes a `?url=` from any AuthGuard principal
 * (Portal's push key included) and used to send the saved key there when no probe header came
 * with it: pointing `?url=` at a listener was enough to read the key.
 */
describe('InferenceController — Re-check probes and the saved keys', () => {
  let controller: InferenceController;
  let configuration: MockProxy<ConfigurationService>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  const savedOmlxKey = process.env.OMLX_API_KEY;

  const profile = { gpu: { vendor: 'nvidia', available: true, unifiedMemory: false }, npu: { available: false }, tier: 'high' } as HardwareProfile;

  /** The Authorization header each probe of `/v1/models` carried, keyed by the URL it went to. */
  const modelsProbes = () =>
    get.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/models'))
      .map(([url, config]) => ({
        url: String(url),
        authorization: (config as { headers?: Record<string, string> } | undefined)?.headers?.Authorization,
      }));

  beforeEach(async () => {
    get.mockReset();
    get.mockResolvedValue({ status: 200, data: { data: [] } });
    process.env.OMLX_API_KEY = 'omlx-saved-key';

    configuration = mock<ConfigurationService>();
    configuration.getInferencePreferences.mockReturnValue({
      preferredBackend: 'vllm',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: 'vllm-saved-key',
      preferredVllmUrl: SAVED_VLLM_URL,
      preferredOmlxUrl: SAVED_OMLX_URL,
    } as never);
    hardwareInspector = mock<HardwareInspectorService>();
    hardwareInspector.getProfile.mockResolvedValue(profile);

    const modelRegistry = mock<ModelRegistryService>();
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForHardware.mockReturnValue([]);
    modelRegistry.getCatalog.mockReturnValue([]);
    const memoryManager = mock<MemoryManagerService>();
    memoryManager.calculateBudget.mockResolvedValue({ modelBudgetVramMb: 0, modelUsedVramMb: 0, modelBudgetRamMb: 0, modelUsedRamMb: 0 } as never);
    const router = mock<InferenceRouterService>();
    router.getStatus.mockResolvedValue({ backends: [] } as unknown as InferenceStatus);
    const hostMetrics = mock<HostMetricsService>();
    hostMetrics.readHostSection.mockResolvedValue(null);
    hostMetrics.getDisplayLoad.mockResolvedValue({ diskSize: 0, diskUsed: 0 } as never);
    const ollamaBackend = mock<OllamaBackend>();
    ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });

    const moduleRef = await Test.createTestingModule({
      controllers: [InferenceController],
      providers: [
        { provide: InferenceRouterService, useValue: router },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: MemoryManagerService, useValue: memoryManager },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: ModelPullerService, useValue: mock<ModelPullerService>() },
        { provide: CloudFallbackService, useValue: mock<CloudFallbackService>() },
        { provide: OllamaInstallerService, useValue: mock<OllamaInstallerService>() },
        { provide: RocmInstallerService, useValue: mock<RocmInstallerService>() },
        { provide: AppCredentialsService, useValue: mock<AppCredentialsService>() },
        { provide: DockerReadFacade, useValue: mock<DockerReadFacade>() },
        { provide: HostMetricsService, useValue: hostMetrics },
        { provide: ConfigurationService, useValue: configuration },
        { provide: OllamaBackend, useValue: ollamaBackend },
        VllmBackend,
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        OmlxBackend,
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
  });

  afterEach(() => {
    if (savedOmlxKey === undefined) delete process.env.OMLX_API_KEY;
    else process.env.OMLX_API_KEY = savedOmlxKey;
  });

  describe('GET vllm/status', () => {
    it('sends the saved vLLM key nowhere but the saved vLLM URL', async () => {
      await controller.getVllmStatus({ url: LISTENER });

      expect(modelsProbes()).toEqual([{ url: `${LISTENER}/v1/models`, authorization: undefined }]);
    });

    it('still sends it when re-checking the saved server, with or without ?url=', async () => {
      await controller.getVllmStatus({ url: `${SAVED_VLLM_URL}/v1/` });
      await controller.getVllmStatus();

      expect(modelsProbes().map((p) => p.authorization)).toEqual(['Bearer vllm-saved-key', 'Bearer vllm-saved-key']);
    });

    it('sends the key in the probe header to the URL being checked, unchanged', async () => {
      await controller.getVllmStatus({ url: LISTENER }, 'typed-vllm-key');

      expect(modelsProbes()).toEqual([{ url: `${LISTENER}/v1/models`, authorization: 'Bearer typed-vllm-key' }]);
    });
  });

  describe('GET omlx/status', () => {
    it('sends OMLX_API_KEY nowhere but the configured oMLX URL', async () => {
      await controller.getOmlxStatus({ url: LISTENER });

      expect(modelsProbes()).toEqual([{ url: `${LISTENER}/v1/models`, authorization: undefined }]);
    });

    it('still sends it when re-checking the configured server', async () => {
      await controller.getOmlxStatus({ url: SAVED_OMLX_URL });

      expect(modelsProbes()).toEqual([{ url: `${SAVED_OMLX_URL}/v1/models`, authorization: 'Bearer omlx-saved-key' }]);
    });

    it('sends the key in the probe header to the URL being checked, unchanged', async () => {
      await controller.getOmlxStatus({ url: LISTENER }, 'typed-omlx-key');

      expect(modelsProbes()).toEqual([{ url: `${LISTENER}/v1/models`, authorization: 'Bearer typed-omlx-key' }]);
    });
  });

  describe('GET omlx/status on an NVIDIA host', () => {
    // `identity()` in jundot/omlx apps/omlx-cuda-helper/omlx_cuda_helper/discovery.py.
    const HELPER_IDENTITY = {
      node_id: '6f1c2a90-1d2b-4b8e-9b55-0d6f8e7c1a42',
      version: '0.1.3',
      cluster_name: 'omlx',
      friendly_name: 'core-1',
      caps: { chip: '2x NVIDIA RTX A6000', ram_gb: 96.0, backends: ['cuda'], control: 'agent' },
      control_port: 8851,
    };
    const helperProbes = () => get.mock.calls.filter(([url]) => String(url).includes(':8850/'));

    it("hands out the helper's run command, not Homebrew, while the helper is not running", async () => {
      const status = await controller.getOmlxStatus();

      expect(status.ready).toBe(false);
      expect(status.remediationCommand).toBe(OMLX_CUDA_HELPER_RUN_COMMAND);
      expect(status.hint).toContain('Prefill Accelerator helper');
      // There is no local oMLX to point at, so the note about probing from the container is left out.
      expect(status.hint).not.toContain('host.docker.internal:8000');
      expect(status.prefillHelper).toEqual({ running: false });
      expect(helperProbes()).toHaveLength(1);
    });

    it('hands out the pairing command once the helper answers on :8850', async () => {
      get.mockImplementation(async (url: string) =>
        String(url).endsWith(':8850/api/cluster/node_id') ? { status: 200, data: HELPER_IDENTITY } : { status: 200, data: { data: [] } },
      );

      const status = await controller.getOmlxStatus();

      expect(status.remediationCommand).toBe(OMLX_CUDA_HELPER_PAIRING_COMMAND);
      expect(status.hint).toContain('press Pair on "core-1"');
      expect(status.prefillHelper).toMatchObject({ running: true, version: '0.1.3', chip: '2x NVIDIA RTX A6000' });
    });

    it('keeps the Homebrew guidance on Apple Silicon, and never asks :8850 there', async () => {
      hardwareInspector.getProfile.mockResolvedValue({ ...profile, gpu: { ...profile.gpu, vendor: 'apple' } } as HardwareProfile);

      const status = await controller.getOmlxStatus();

      expect(status.remediationCommand).toContain('brew install jundot/omlx/omlx');
      expect(status.hint).toContain('host.docker.internal:8000');
      expect(status).not.toHaveProperty('prefillHelper');
      expect(helperProbes()).toHaveLength(0);
    });
  });

  describe('GET onboarding-profile', () => {
    it('sends no saved vLLM key to a ?vllmUrl= listener', async () => {
      await controller.getOnboardingProfile({ backend: 'vllm', vllmUrl: LISTENER });

      expect(modelsProbes()).toEqual([{ url: `${LISTENER}/v1/models`, authorization: undefined }]);
    });

    it('sends no OMLX_API_KEY to a ?omlxUrl= listener', async () => {
      await controller.getOnboardingProfile({ backend: 'omlx', omlxUrl: LISTENER });

      expect(modelsProbes()).toEqual([{ url: `${LISTENER}/v1/models`, authorization: undefined }]);
    });

    it('sends the probe header keys to the URLs being checked, unchanged', async () => {
      await controller.getOnboardingProfile({ backend: 'vllm', vllmUrl: LISTENER }, 'typed-vllm-key');
      await controller.getOnboardingProfile({ backend: 'omlx', omlxUrl: LISTENER }, undefined, 'typed-omlx-key');

      expect(modelsProbes().map((p) => p.authorization)).toEqual(['Bearer typed-vllm-key', 'Bearer typed-omlx-key']);
    });
  });
});
