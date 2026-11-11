import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HardwareProfile, InferenceModelInfo, InferenceStatus } from '@ci-hub/common/types';
import type { LifecycleActorFor } from '@/core/portal/lifecycle-actor';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { MemoryManagerService } from '@/modules/inference/memory-manager.service';
import { ModelPullerService } from '@/modules/inference/model-puller.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { mcpAdminCallContext, mcpCallContext } from '../../mcp-call-context';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { InferenceTools, filterModels, summarizeInferenceStatus } from '../../tools/inference.tools';

/** Hermes' managed key on core-2: 'write', which every non-destructive tool admits. */
const HERMES_KEY: ApiKeyContext = { id: 7, name: 'Hermes', capability: 'write', ownerAppUrn: null, createdByUserId: null };
const FULL_KEY: ApiKeyContext = { ...HERMES_KEY, id: 8, name: 'automation', capability: 'full' };

const asKey = <T>(key: ApiKeyContext, fn: () => Promise<T>) => mcpCallContext.run(key, fn);
/** A signed-in operator's run from the Hub UI's tool runner. */
const asOperator = <T>(fn: () => Promise<T>) => mcpAdminCallContext.run((() => ({ kind: 'operator' })) as unknown as LifecycleActorFor, fn);

const callTool = (registry: McpToolRegistry, name: string, params: Record<string, unknown>) => {
  const tool = registry.getTool(name);
  if (!tool) throw new Error(`${name} is not registered`);
  return tool.handler(params);
};

describe('InferenceTools — loading and pinning', () => {
  let registry: McpToolRegistry;
  let router: MockProxy<InferenceRouterService>;
  let memoryManager: MockProxy<MemoryManagerService>;

  const call = (name: string, params: Record<string, unknown>) => callTool(registry, name, params);

  beforeEach(() => {
    registry = new McpToolRegistry();
    router = mock<InferenceRouterService>();
    memoryManager = mock<MemoryManagerService>();
    const hardware = mock<HardwareInspectorService>();
    hardware.getProfile.mockResolvedValue({ tier: 'high' } as HardwareProfile);
    memoryManager.canPinModel.mockResolvedValue({ canPin: true });
    router.loadTrackedModel.mockResolvedValue({ loaded: true });
    new InferenceTools(
      mock<LoggerService>(),
      registry,
      hardware,
      memoryManager,
      mock<ModelPullerService>(),
      router,
      mock<CloudFallbackService>(),
      mock<InferenceBackendRegistry>(),
    ).onModuleInit();
  });

  // SEC-2: Hermes' and OpenClaw's managed keys are 'write', and hub_load_model used to let them
  // evict the model every other app on the node was serving.
  describe('hub_load_model', () => {
    // `agent` evicts by the app request path's rule (the router maps it to the `request` scope).
    it("gives an agent's key the app request path's rule: only the Hub's own idle loads may go", async () => {
      await asKey(HERMES_KEY, () => call('hub_load_model', { modelId: 'qwen3-coder-30b' }));
      expect(router.loadTrackedModel).toHaveBeenCalledWith('qwen3-coder-30b', { origin: 'agent' });
    });

    it("gives a 'full' key the same rule: it is still an agent, not an operator at the Hub", async () => {
      await asKey(FULL_KEY, () => call('hub_load_model', { modelId: 'qwen3-coder-30b' }));
      expect(router.loadTrackedModel).toHaveBeenCalledWith('qwen3-coder-30b', { origin: 'agent' });
    });

    it("gives an operator's run from the tool runner the operator's rule", async () => {
      await asOperator(() => call('hub_load_model', { modelId: 'qwen3-coder-30b' }));
      expect(router.loadTrackedModel).toHaveBeenCalledWith('qwen3-coder-30b', { origin: 'operator' });
    });

    it("fails closed to the agent's rule when the call carries no context", async () => {
      await call('hub_load_model', { modelId: 'qwen3-coder-30b' });
      expect(router.loadTrackedModel).toHaveBeenCalledWith('qwen3-coder-30b', { origin: 'agent' });
    });

    it('answers a refusal with its reason', async () => {
      router.loadTrackedModel.mockResolvedValue({ loaded: false, reason: 'gemma4:e4b is serving a request and will not be unloaded' });

      await expect(asKey(HERMES_KEY, () => call('hub_load_model', { modelId: 'qwen3-coder-30b' }))).resolves.toEqual({
        success: false,
        message: 'gemma4:e4b is serving a request and will not be unloaded',
      });
    });
  });

  // NIT-1: the tool marked a model pinned without loading it — and, untracked, pinned nothing while
  // answering success.
  // The pin goes through the router's pinTrackedModel, which loads a model not in memory through the
  // same load path first (see the router's tests); what this tool decides is who is asking.
  describe('hub_pin_model', () => {
    it('pins under the same rule as hub_load_model', async () => {
      router.pinTrackedModel.mockResolvedValue({ pinned: true });

      await expect(asKey(HERMES_KEY, () => call('hub_pin_model', { modelId: 'gemma4-e4b' }))).resolves.toMatchObject({ success: true });
      expect(router.pinTrackedModel).toHaveBeenLastCalledWith('gemma4-e4b', { origin: 'agent' });

      await expect(asOperator(() => call('hub_pin_model', { modelId: 'gemma4-e4b' }))).resolves.toMatchObject({ success: true });
      expect(router.pinTrackedModel).toHaveBeenLastCalledWith('gemma4-e4b', { origin: 'operator' });
    });

    it('answers a pin the router refused with its reason', async () => {
      router.pinTrackedModel.mockResolvedValue({ pinned: false, reason: 'gemma4-e4b is not downloaded on this node; pull it first' });

      await expect(asOperator(() => call('hub_pin_model', { modelId: 'gemma4-e4b' }))).resolves.toEqual({
        success: false,
        message: 'gemma4-e4b is not downloaded on this node; pull it first',
      });
    });
  });

  describe('hub_unpin_model', () => {
    it("unpins through the router, which also hands the model back to Ollama's default keep_alive", async () => {
      router.unpinTrackedModel.mockResolvedValue({ engine: 'set' });

      await expect(asOperator(() => call('hub_unpin_model', { modelId: 'gemma4-e2b' }))).resolves.toEqual({
        success: true,
        message: 'Model gemma4-e2b unpinned',
      });
      expect(router.unpinTrackedModel).toHaveBeenCalledWith('gemma4-e2b');
    });
  });
});

// The schema requires `apiKey`, so a call that means "keep the stored key" sends an empty string. That
// keeps the key only while the provider stays on the server it was saved for, as a REST save does.
describe('InferenceTools: hub_set_cloud_provider', () => {
  let registry: McpToolRegistry;
  let cloudFallback: CloudFallbackService;

  const call = (name: string, params: Record<string, unknown>) => callTool(registry, name, params);

  beforeEach(() => {
    registry = new McpToolRegistry();
    const configuration = mock<ConfigurationService>();
    configuration.getInferenceCloudProviders.mockReturnValue([{ provider: 'openai', apiKey: 'sk-saved', enabled: true, defaultModel: 'gpt-4o' }]);
    configuration.setInferenceCloudProviders.mockResolvedValue([]);
    cloudFallback = new CloudFallbackService(mock<LoggerService>(), configuration);
    cloudFallback.onModuleInit();
    new InferenceTools(
      mock<LoggerService>(),
      registry,
      mock<HardwareInspectorService>(),
      mock<MemoryManagerService>(),
      mock<ModelPullerService>(),
      mock<InferenceRouterService>(),
      cloudFallback,
      mock<InferenceBackendRegistry>(),
    ).onModuleInit();
  });

  it('keeps the stored key for an empty apiKey that leaves the base URL alone', async () => {
    await asKey(HERMES_KEY, () => call('hub_set_cloud_provider', { provider: 'openai', apiKey: '', enabled: false }));

    expect(cloudFallback.getProvider('openai')).toMatchObject({ apiKey: 'sk-saved', enabled: false });
  });

  it('drops the stored key for an empty apiKey with a base URL on another server', async () => {
    await asKey(HERMES_KEY, () =>
      call('hub_set_cloud_provider', { provider: 'openai', apiKey: '', enabled: true, baseUrl: 'https://proxy.example.test/v1' }),
    );

    expect(cloudFallback.getProvider('openai')?.apiKey).toBeUndefined();
    await expect(call('hub_get_cloud_providers', {})).resolves.toEqual([expect.objectContaining({ provider: 'openai', configured: false })]);
  });
});

describe('InferenceTools: status and model list sizes', () => {
  const model = (over: Partial<InferenceModelInfo>): InferenceModelInfo => ({
    id: 'm',
    object: 'model',
    created: 1,
    owned_by: 'catalog:ollama',
    state: 'available',
    backend: 'ollama',
    modality: ['text'],
    local: true,
    ...over,
  });
  const models: InferenceModelInfo[] = [
    model({ id: 'qwen3.5:27b', owned_by: 'local:ollama', state: 'loaded', context_window: 32768 }),
    model({ id: 'gemma3-4b', owned_by: 'local:ollama', state: 'pulled', backend_model_id: 'gemma3:4b' }),
    model({ id: 'gpt-4o-mini', owned_by: 'cloud:openai', backend: 'cloud', local: false }),
    model({ id: 'phi-4-mini' }),
    model({ id: 'llama-3.3-8b-instruct' }),
    model({ id: 'qwen-omlx', owned_by: 'catalog:omlx', backend: 'omlx' }),
  ];
  const status = {
    hardwareTier: 'high',
    backends: [{ type: 'ollama', running: true, healthy: true, url: 'http://host.docker.internal:11434', modelsLoaded: 2 }],
    models,
    memoryBudget: { totalRamMb: 125781 },
    cloudProviders: [{ provider: 'openai', enabled: true, configured: true }],
  } as unknown as InferenceStatus;

  let registry: McpToolRegistry;
  let router: MockProxy<InferenceRouterService>;

  beforeEach(() => {
    registry = new McpToolRegistry();
    router = mock<InferenceRouterService>();
    router.getStatus.mockResolvedValue(status);
    router.listModels.mockResolvedValue(models);
    new InferenceTools(
      mock<LoggerService>(),
      registry,
      mock<HardwareInspectorService>(),
      mock<MemoryManagerService>(),
      mock<ModelPullerService>(),
      router,
      mock<CloudFallbackService>(),
      mock<InferenceBackendRegistry>(),
    ).onModuleInit();
  });

  it('lists only the models this node can serve and counts the catalog per backend', () => {
    const summary = summarizeInferenceStatus(status);
    expect(summary.models.map((m) => m.id)).toEqual(['qwen3.5:27b', 'gemma3-4b', 'gpt-4o-mini']);
    expect(summary.catalog).toMatchObject({ notDownloaded: 3, byBackend: { ollama: 2, omlx: 1 } });
    expect(summary.backends).toBe(status.backends);
    expect(summary.memoryBudget).toBe(status.memoryBudget);
    expect(summary.cloudProviders).toBe(status.cloudProviders);
  });

  it('drops the /v1/models envelope fields from each model and keeps the rest', () => {
    const [loaded, pulled] = summarizeInferenceStatus(status).models;
    expect(loaded).toEqual({ id: 'qwen3.5:27b', state: 'loaded', backend: 'ollama', modality: ['text'], context_window: 32768 });
    expect(pulled).toMatchObject({ backend_model_id: 'gemma3:4b' });
  });

  it('hub_get_inference_status answers with the summary unless includeCatalog is true', async () => {
    const tool = registry.getTool('hub_get_inference_status');
    await expect(tool?.handler({})).resolves.toEqual(summarizeInferenceStatus(status));
    await expect(tool?.handler({ includeCatalog: true })).resolves.toBe(status);
  });

  it('hub_list_models filters by backend and by state, and lists everything without a filter', async () => {
    const tool = registry.getTool('hub_list_models');
    await expect(tool?.handler({})).resolves.toEqual(models);
    const omlx = (await tool?.handler({ backend: 'omlx' })) as InferenceModelInfo[];
    expect(omlx.map((m) => m.id)).toEqual(['qwen-omlx']);
    const pulled = (await tool?.handler({ backend: 'ollama', state: 'pulled' })) as InferenceModelInfo[];
    expect(pulled.map((m) => m.id)).toEqual(['gemma3-4b']);
  });

  it('ignores a filter that is not a non-empty string', () => {
    expect(filterModels(models, { backend: '', state: 3 })).toEqual(models);
  });
});
