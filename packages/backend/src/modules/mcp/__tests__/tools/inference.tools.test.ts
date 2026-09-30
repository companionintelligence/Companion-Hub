import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { CuratedModel, HardwareProfile } from '@ci-hub/common/types';
import type { LifecycleActorFor } from '@/core/portal/lifecycle-actor';
import { LoggerService } from '@/core/logger/logger.service';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { MemoryManagerService } from '@/modules/inference/memory-manager.service';
import { ModelPullerService } from '@/modules/inference/model-puller.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { mcpAdminCallContext, mcpCallContext } from '../../mcp-call-context';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { InferenceTools } from '../../tools/inference.tools';

/** Hermes' managed key on core-2: 'write', which every non-destructive tool admits. */
const HERMES_KEY: ApiKeyContext = { id: 7, name: 'Hermes', capability: 'write', ownerAppUrn: null, createdByUserId: null };
const FULL_KEY: ApiKeyContext = { ...HERMES_KEY, id: 8, name: 'automation', capability: 'full' };

const asKey = <T>(key: ApiKeyContext, fn: () => Promise<T>) => mcpCallContext.run(key, fn);
/** A signed-in operator's run from the Hub UI's tool runner. */
const asOperator = <T>(fn: () => Promise<T>) => mcpAdminCallContext.run((() => ({ kind: 'operator' })) as unknown as LifecycleActorFor, fn);

describe('InferenceTools — loading and pinning', () => {
  let registry: McpToolRegistry;
  let router: MockProxy<InferenceRouterService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let memoryManager: MockProxy<MemoryManagerService>;

  const call = (name: string, params: Record<string, unknown>) => {
    const tool = registry.getTool(name);
    if (!tool) throw new Error(`${name} is not registered`);
    return tool.handler(params);
  };

  beforeEach(() => {
    registry = new McpToolRegistry();
    router = mock<InferenceRouterService>();
    modelRegistry = mock<ModelRegistryService>();
    memoryManager = mock<MemoryManagerService>();
    const hardware = mock<HardwareInspectorService>();
    hardware.getProfile.mockResolvedValue({ tier: 'high' } as HardwareProfile);
    modelRegistry.getCuratedModel.mockReturnValue({ runtime: { memoryFootprintMb: 6_640 } } as CuratedModel);
    memoryManager.canPinModel.mockResolvedValue({ canPin: true });
    router.loadTrackedModel.mockResolvedValue({ loaded: true });
    new InferenceTools(
      mock<LoggerService>(),
      registry,
      hardware,
      modelRegistry,
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
});
