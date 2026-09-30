import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { MemoryManagerService } from '@/modules/inference/memory-manager.service';
import { ModelPullerService } from '@/modules/inference/model-puller.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { mcpCallerIsOperator } from '../mcp-tool-call';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import type { InferenceBackendType, CloudProviderType } from '@ci-hub/common/types';

@Injectable()
export class InferenceTools implements OnModuleInit {
  constructor(
    private readonly logger: LoggerService,
    private readonly registry: McpToolRegistry,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly memoryManager: MemoryManagerService,
    private readonly modelPuller: ModelPullerService,
    private readonly inferenceRouter: InferenceRouterService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly backends: InferenceBackendRegistry,
  ) {}

  onModuleInit() {
    // ─── hub_get_hardware_profile ────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_get_hardware_profile',
      access: 'read',
      description:
        'Get detected hardware capabilities (GPU, VRAM, RAM, NPU) and computed tier. Returns the full hardware profile used for model selection.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const profile = await this.hardwareInspector.getProfile();
        return profile;
      },
    });

    // ─── hub_list_inference_backends ─────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_list_inference_backends',
      access: 'read',
      description: 'List available inference backends (Ollama, vLLM, Lemonade, and oMLX) and their current status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const results = await Promise.all(
          this.backends.entries().map(async ([type, b]) => {
            const health = await b.healthCheck();
            return {
              type,
              baseUrl: b.getBaseUrl(),
              running: health.running,
              healthy: health.healthy,
              modelsLoaded: health.modelsLoaded,
              error: health.error,
            };
          }),
        );
        return results;
      },
    });

    // ─── hub_start_inference_backend ────────────────────────────────
    // ISSUE-MCP-3: inference backends (Ollama, vLLM, Lemonade, and oMLX) are managed
    // by the Hub runtime and host services, not started on demand by the Hub. The previous handler
    // returned a "start requested" message but did nothing — misleading an agent into believing a
    // backend was started. This now honestly reports live status and states that lifecycle is not
    // performed here. (Real on-demand start/stop would need a public compose-orchestration path in
    // the inference module — tracked separately.)
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_start_inference_backend',
      access: 'write',
      description:
        'Report the live status of an inference backend ("ollama", "omlx", "vllm", or "lemonade"). NOTE: this does NOT ' +
        'start a container — inference backends are managed by the Hub runtime/compose stack. Use it to verify ' +
        'whether a backend is up before routing inference.',
      inputSchema: {
        type: 'object',
        properties: {
          backend: { type: 'string', enum: [...INFERENCE_BACKEND_TYPES], description: 'Backend type to check' },
        },
        required: ['backend'],
      },
      handler: (params) => this.reportBackendLifecycle(params.backend as InferenceBackendType, 'start'),
    });

    // ─── hub_stop_inference_backend ─────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_stop_inference_backend',
      access: 'write',
      description:
        'Report the live status of an inference backend. NOTE: this does NOT stop a container — inference ' +
        'backends are managed by the Hub runtime/compose stack, not stopped on demand via MCP.',
      inputSchema: {
        type: 'object',
        properties: {
          backend: { type: 'string', enum: [...INFERENCE_BACKEND_TYPES], description: 'Backend type to check' },
        },
        required: ['backend'],
      },
      handler: (params) => this.reportBackendLifecycle(params.backend as InferenceBackendType, 'stop'),
    });

    // ─── hub_list_models ────────────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_list_models',
      access: 'read',
      description:
        'List all models: curated catalog entries, pulled/loaded models, and cloud models. Shows state (available, pulling, pulled, loaded, pinned, error).',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const models = await this.inferenceRouter.listModels();
        return models;
      },
    });

    // ─── hub_pull_model ─────────────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_pull_model',
      access: 'write',
      description: 'Pull/download a model from the curated catalog to the local backend. Long-running operation.',
      inputSchema: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Catalog model ID (e.g. "phi-4-mini", "llama-3.3-8b-instruct")' },
        },
        required: ['modelId'],
      },
      handler: async (params) => {
        const modelId = params.modelId as string;
        await this.modelPuller.pullAndWait(modelId);
        return { success: true, message: `Model ${modelId} pulled successfully` };
      },
    });

    // ─── hub_load_model ─────────────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_load_model',
      access: 'write',
      description:
        'Load a pulled model into memory for inference. To make room it unloads only idle models the Hub itself loaded, ' +
        'never one serving a request; when that is not enough the load is refused with the reason and nothing is unloaded.',
      inputSchema: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Catalog model ID to load' },
        },
        required: ['modelId'],
      },
      handler: async (params) => {
        const modelId = params.modelId as string;
        const outcome = await this.inferenceRouter.loadTrackedModel(modelId, { origin: this.loadOrigin() });
        if (!outcome.loaded) {
          return { success: false, message: outcome.reason };
        }
        return { success: true, message: `Model ${modelId} loaded` };
      },
    });

    // ─── hub_unload_model ───────────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_unload_model',
      access: 'write',
      description: 'Unload a model from memory.',
      inputSchema: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Catalog model ID to unload' },
        },
        required: ['modelId'],
      },
      handler: async (params) => {
        const modelId = params.modelId as string;
        await this.modelPuller.unloadModel(modelId);
        return { success: true, message: `Model ${modelId} unloaded` };
      },
    });

    // ─── hub_pin_model ──────────────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_pin_model',
      access: 'write',
      description:
        'Pin a model in memory (prevent eviction while the backend is running), loading it first if it is not loaded, ' +
        'the same way hub_load_model does. Pinning is not persisted across backend restarts.',
      inputSchema: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Catalog model ID to pin' },
        },
        required: ['modelId'],
      },
      handler: async (params) => {
        const modelId = params.modelId as string;
        // The REST pin's path: loaded first when it is not in memory — making room only as this
        // caller may (see loadOrigin) — then checked against the pinned-model budget with what it was
        // measured occupying here. This tool used to check the catalog's figure only and mark the
        // model pinned whether or not it was in memory, or, untracked, pin nothing and answer success.
        const outcome = await this.inferenceRouter.pinTrackedModel(modelId, { origin: this.loadOrigin() });
        if (!outcome.pinned) {
          return { success: false, message: outcome.reason };
        }
        return { success: true, message: `Model ${modelId} pinned in memory` };
      },
    });

    // ─── hub_unpin_model ────────────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_unpin_model',
      access: 'write',
      description: 'Unpin a model (allow eviction when memory is needed).',
      inputSchema: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Catalog model ID to unpin' },
        },
        required: ['modelId'],
      },
      handler: async (params) => {
        const modelId = params.modelId as string;
        this.modelRegistry.unpinModel(modelId);
        return { success: true, message: `Model ${modelId} unpinned` };
      },
    });

    // ─── hub_get_inference_status ───────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_get_inference_status',
      access: 'read',
      description:
        'Get full inference router status: hardware tier, backend health, loaded models, memory budget, and cloud providers. Used by OpenClaw and agents to discover inference capabilities.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        return this.inferenceRouter.getStatus();
      },
    });

    // ─── hub_get_memory_budget ──────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_get_memory_budget',
      access: 'read',
      description: 'Get current memory budget breakdown: VRAM, RAM, system reserved, app containers, model usage, pinned.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const profile = await this.hardwareInspector.getProfile();
        return await this.memoryManager.calculateBudget(profile);
      },
    });

    // ─── hub_set_cloud_provider ─────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_set_cloud_provider',
      access: 'write',
      description: 'Configure a cloud fallback provider (OpenAI, Anthropic, Google, GitHub Copilot).',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['openai', 'anthropic', 'google', 'github-copilot'], description: 'Cloud provider type' },
          apiKey: { type: 'string', description: 'API key for the provider' },
          enabled: { type: 'boolean', description: 'Whether this provider is enabled' },
          baseUrl: { type: 'string', description: 'Custom base URL (optional)' },
          defaultModel: { type: 'string', description: 'Default model for this provider' },
        },
        required: ['provider', 'apiKey', 'enabled'],
      },
      handler: async (params) => {
        this.cloudFallback.setProvider({
          provider: params.provider as CloudProviderType,
          apiKey: params.apiKey as string,
          enabled: params.enabled as boolean,
          baseUrl: params.baseUrl as string | undefined,
          defaultModel: (params.defaultModel as string) || this.cloudFallback.getDefaultModel(params.provider as CloudProviderType),
        });
        return { success: true };
      },
    });

    // ─── hub_get_cloud_providers ────────────────────────────────────
    this.registry.register({
      category: 'Inference & Models',
      name: 'hub_get_cloud_providers',
      access: 'read',
      description: 'List configured cloud fallback providers.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        return this.cloudFallback.listProviders().map((p) => ({
          provider: p.provider,
          enabled: p.enabled,
          configured: !!p.apiKey,
          defaultModel: p.defaultModel,
        }));
      },
    });

    // NOTE: The Hub no longer proxies inference requests. Apps (and agents) talk
    // to the Ollama container's OpenAI-compatible /v1 (or a cloud provider)
    // directly using the connection info from GET /api/inference/apps/:slug/credentials.
    // The former hub_inference_chat / hub_inference_tts / hub_inference_stt proxy
    // tools were removed accordingly.

    this.logger.info('[InferenceTools] Registered 14 inference MCP tools');
  }

  /**
   * Who a load from this tool call is, which decides what it may unload to make room (see
   * `LoadOrigin`). An agent's key — Hermes' and OpenClaw's managed keys are 'write' — gets the app
   * request path's rule: only idle models the Hub itself loaded. Otherwise a prompt-injected agent
   * could evict the model every other app on the node is serving, and apps would keep evicting each
   * other. Only an operator's run from the Hub UI's tool runner may unload models apps loaded, as the
   * REST pin and load do. Either way the Hub picks the window, as for any load that is not a request.
   */
  private loadOrigin(): 'operator' | 'agent' {
    return mcpCallerIsOperator() ? 'operator' : 'agent';
  }

  /**
   * ISSUE-MCP-3: honestly report a backend's live status. Backend lifecycle (start/stop) is owned by
   * the Hub runtime/compose stack, so this never mutates state — it health-checks the requested
   * backend and returns `supported: false` for the lifecycle action plus its current running state.
   */
  private async reportBackendLifecycle(
    backendType: InferenceBackendType,
    action: 'start' | 'stop',
  ): Promise<{
    supported: false;
    backend: InferenceBackendType;
    action: 'start' | 'stop';
    running: boolean;
    healthy: boolean;
    baseUrl: string;
    message: string;
  }> {
    const backend = this.backends.get(backendType);
    const health = await backend.healthCheck();
    // Naive `${action}ed` mis-conjugates "stop" → "stoped"; map to the correct past tense.
    const actionPastTense = action === 'stop' ? 'stopped' : 'started';
    return {
      supported: false,
      backend: backendType,
      action,
      running: health.running,
      healthy: health.healthy,
      baseUrl: backend.getBaseUrl(),
      message:
        `Inference backends are managed by the Hub runtime (compose stack / host services), not ${actionPastTense} on demand via MCP. ` +
        `Backend "${backendType}" is currently ${health.running ? 'running' : 'not running'}. ` +
        'Use the Hub AI settings to change backend or model configuration.',
    };
  }
}
