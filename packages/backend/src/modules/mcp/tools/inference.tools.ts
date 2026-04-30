import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { MemoryManagerService } from '@/modules/inference/memory-manager.service';
import { ModelPullerService } from '@/modules/inference/model-puller.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
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
    private readonly ollamaBackend: OllamaBackend,
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
  ) {}

  onModuleInit() {
    // ─── hub_get_hardware_profile ────────────────────────────────────
    this.registry.register({
      name: 'hub_get_hardware_profile',
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
      name: 'hub_list_inference_backends',
      description: 'List available inference backends (Ollama, vLLM, Lemonade) and their current status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const backends = [this.ollamaBackend, this.vllmBackend, this.lemonadeBackend];
        const results = await Promise.all(
          backends.map(async (b) => {
            const health = await b.healthCheck();
            return {
              type: b.type,
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
    this.registry.register({
      name: 'hub_start_inference_backend',
      description: 'Start an inference backend. Requires the backend type: "ollama", "vllm", or "lemonade".',
      inputSchema: {
        type: 'object',
        properties: {
          backend: { type: 'string', enum: ['ollama', 'vllm', 'lemonade'], description: 'Backend type to start' },
        },
        required: ['backend'],
      },
      handler: async (params) => {
        const backendType = params.backend as InferenceBackendType;
        return { message: `Backend ${backendType} start requested. Use Docker lifecycle to manage backend containers.`, backendType };
      },
    });

    // ─── hub_stop_inference_backend ─────────────────────────────────
    this.registry.register({
      name: 'hub_stop_inference_backend',
      description: 'Stop an inference backend.',
      inputSchema: {
        type: 'object',
        properties: {
          backend: { type: 'string', enum: ['ollama', 'vllm', 'lemonade'], description: 'Backend type to stop' },
        },
        required: ['backend'],
      },
      handler: async (params) => {
        const backendType = params.backend as InferenceBackendType;
        return { message: `Backend ${backendType} stop requested.`, backendType };
      },
    });

    // ─── hub_list_models ────────────────────────────────────────────
    this.registry.register({
      name: 'hub_list_models',
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
      name: 'hub_pull_model',
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
        await this.modelPuller.pullModel(modelId);
        return { success: true, message: `Model ${modelId} pulled successfully` };
      },
    });

    // ─── hub_load_model ─────────────────────────────────────────────
    this.registry.register({
      name: 'hub_load_model',
      description: 'Load a pulled model into memory for inference.',
      inputSchema: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Catalog model ID to load' },
        },
        required: ['modelId'],
      },
      handler: async (params) => {
        const modelId = params.modelId as string;
        await this.modelPuller.loadModel(modelId);
        return { success: true, message: `Model ${modelId} loaded` };
      },
    });

    // ─── hub_unload_model ───────────────────────────────────────────
    this.registry.register({
      name: 'hub_unload_model',
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
      name: 'hub_pin_model',
      description: 'Pin a model in memory (prevent eviction). Pinned models stay loaded across backend restarts.',
      inputSchema: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Catalog model ID to pin' },
        },
        required: ['modelId'],
      },
      handler: async (params) => {
        const modelId = params.modelId as string;
        const profile = await this.hardwareInspector.getProfile();
        const curated = this.modelRegistry.getCuratedModel(modelId);
        const footprint = curated?.runtime.memoryFootprintMb || 0;
        const canPin = this.memoryManager.canPinModel(profile, footprint);

        if (!canPin.canPin) {
          return { success: false, message: canPin.reason };
        }

        this.modelRegistry.pinModel(modelId);
        return { success: true, message: `Model ${modelId} pinned in memory` };
      },
    });

    // ─── hub_unpin_model ────────────────────────────────────────────
    this.registry.register({
      name: 'hub_unpin_model',
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
      name: 'hub_get_inference_status',
      description:
        'Get full inference router status: hardware tier, backend health, loaded models, memory budget, and cloud providers. Used by OpenClaw and agents to discover inference capabilities.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        return this.inferenceRouter.getStatus();
      },
    });

    // ─── hub_get_memory_budget ──────────────────────────────────────
    this.registry.register({
      name: 'hub_get_memory_budget',
      description: 'Get current memory budget breakdown: VRAM, RAM, system reserved, app containers, model usage, pinned.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const profile = await this.hardwareInspector.getProfile();
        return this.memoryManager.calculateBudget(profile);
      },
    });

    // ─── hub_set_cloud_provider ─────────────────────────────────────
    this.registry.register({
      name: 'hub_set_cloud_provider',
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
          defaultModel: (params.defaultModel as string) || (params.provider as string),
        });
        return { success: true };
      },
    });

    // ─── hub_get_cloud_providers ────────────────────────────────────
    this.registry.register({
      name: 'hub_get_cloud_providers',
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

    // ─── hub_inference_chat ─────────────────────────────────────────
    this.registry.register({
      name: 'hub_inference_chat',
      description: 'Send a chat completion request through the inference router. Routes to local backend or cloud automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model ID or "auto" for default. Defaults to "auto".' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                content: { type: 'string' },
              },
              required: ['role', 'content'],
            },
            description: 'Chat messages array',
          },
          temperature: { type: 'number', description: 'Sampling temperature (0-2)' },
          max_tokens: { type: 'number', description: 'Maximum tokens to generate' },
        },
        required: ['messages'],
      },
      handler: async (params) => {
        const result = await this.inferenceRouter.routeChatCompletion({
          model: (params.model as string) || 'auto',
          messages: params.messages,
          temperature: params.temperature,
          max_tokens: params.max_tokens,
          stream: false,
        });
        return { backend: result.backend, response: result.data };
      },
    });

    // ─── hub_inference_tts ──────────────────────────────────────────
    this.registry.register({
      name: 'hub_inference_tts',
      description: 'Generate speech from text through the inference router.',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Text to synthesize' },
          model: { type: 'string', description: 'TTS model (default: kokoro-v1)' },
          voice: { type: 'string', description: 'Voice name (default: "default")' },
        },
        required: ['input'],
      },
      handler: async (params) => {
        const result = await this.inferenceRouter.routeTts({
          input: params.input as string,
          model: (params.model as string) || 'kokoro-v1',
          voice: (params.voice as string) || 'default',
        });
        return {
          backend: result.backend,
          audioSize: result.data.length,
          message: 'Audio generated. Use /api/inference/v1/audio/speech endpoint directly for binary audio data.',
        };
      },
    });

    // ─── hub_inference_stt ──────────────────────────────────────────
    this.registry.register({
      name: 'hub_inference_stt',
      description:
        'Transcribe audio through the inference router. Note: use the /api/inference/v1/audio/transcriptions endpoint directly for file uploads.',
      inputSchema: {
        type: 'object',
        properties: {
          audioUrl: { type: 'string', description: 'URL of audio to transcribe (if available)' },
        },
        required: [],
      },
      handler: async () => {
        return {
          message: 'Audio transcription requires file upload. Use POST /api/inference/v1/audio/transcriptions with multipart form data.',
          endpoint: '/api/inference/v1/audio/transcriptions',
        };
      },
    });

    this.logger.info('[InferenceTools] Registered 16 inference MCP tools');
  }
}
