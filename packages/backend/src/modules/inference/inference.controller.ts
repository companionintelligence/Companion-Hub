import { Body, Controller, Get, Post, Res, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { InferenceRouterService } from './inference-router.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { MemoryManagerService } from './memory-manager.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import type { CloudProviderType } from '@ci-hub/common/types';

/**
 * Inference controller — exposes OpenAI-compatible inference endpoints.
 * All apps and agents talk to these endpoints; the router decides which backend handles each request.
 */
@Controller('inference')
export class InferenceController {
  constructor(
    private readonly router: InferenceRouterService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly memoryManager: MemoryManagerService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly modelPuller: ModelPullerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly logger: LoggerService,
  ) {}

  // ─── OpenAI-Compatible Endpoints ──────────────────────────────────────

  @Post('v1/chat/completions')
  async chatCompletions(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      const result = await this.router.routeChatCompletion(body);

      if (result.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Inference-Backend', result.backend);
        (result.stream as NodeJS.ReadableStream).pipe(res);
        return;
      }

      res.setHeader('X-Inference-Backend', result.backend);
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Inference] Chat completion error: ${message}`);
      res.status(500).json({ error: { message, type: 'server_error', param: null, code: null } });
    }
  }

  @Post('v1/completions')
  async completions(@Body() _body: Record<string, unknown>, @Res() res: Response) {
    // Legacy completions API not supported — use /v1/chat/completions instead
    res.status(404).json({
      error: {
        message: 'The completions API is not supported. Use /v1/chat/completions instead.',
        type: 'invalid_request_error',
        param: null,
        code: 'unsupported_endpoint',
      },
    });
  }

  @Post('v1/audio/speech')
  async tts(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      const result = await this.router.routeTts(body);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Inference-Backend', result.backend);
      res.send(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Inference] TTS error: ${message}`);
      res.status(500).json({ error: { message, type: 'server_error', param: null, code: null } });
    }
  }

  @Post('v1/audio/transcriptions')
  @UseInterceptors(FileInterceptor('file'))
  async stt(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string } | undefined,
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      if (!file) {
        res.status(400).json({ error: { message: 'No audio file provided', type: 'invalid_request_error', param: 'file', code: null } });
        return;
      }

      // Rebuild FormData with the uploaded file for backend forwarding
      const formData = new FormData();
      const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
      formData.append('file', blob, file.originalname);
      for (const [key, value] of Object.entries(body)) {
        formData.append(key, value);
      }

      const result = await this.router.routeStt(formData);
      res.setHeader('X-Inference-Backend', result.backend);
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Inference] STT error: ${message}`);
      res.status(500).json({ error: { message, type: 'server_error', param: null, code: null } });
    }
  }

  @Post('v1/embeddings')
  async embeddings(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      const result = await this.router.routeEmbeddings(body);
      res.setHeader('X-Inference-Backend', result.backend);
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Inference] Embeddings error: ${message}`);
      res.status(500).json({ error: { message, type: 'server_error', param: null, code: null } });
    }
  }

  @Post('v1/images/generations')
  async imageGen(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      // Image gen only available via Lemonade or cloud
      const provider = this.cloudFallback.getEnabledProviders()[0];
      if (!provider) {
        res.status(503).json({ error: { message: 'No image generation backend available', type: 'server_error', param: null, code: null } });
        return;
      }
      const result = await this.cloudFallback.proxyImageGeneration(provider, body);
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { message, type: 'server_error', param: null, code: null } });
    }
  }

  // ─── Discovery & Health ───────────────────────────────────────────────

  @Get('v1/models')
  async models() {
    const models = await this.router.listModels();
    return { object: 'list', data: models };
  }

  @Get('health')
  async health() {
    const status = await this.router.getStatus();
    const healthy = status.backends.some((b) => b.healthy) || this.cloudFallback.hasCloudFallback();
    return {
      status: healthy ? 'ok' : 'degraded',
      hardwareTier: status.hardwareTier,
      backends: status.backends.map((b) => ({ type: b.type, running: b.running, healthy: b.healthy })),
      cloudFallback: this.cloudFallback.hasCloudFallback(),
    };
  }

  // ─── Management Endpoints ─────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('status')
  async getStatus() {
    return this.router.getStatus();
  }

  @UseGuards(AuthGuard)
  @Get('hardware')
  async getHardware() {
    return this.hardwareInspector.getProfile();
  }

  @UseGuards(AuthGuard)
  @Post('hardware/rescan')
  async rescanHardware() {
    return this.hardwareInspector.rescan();
  }

  @UseGuards(AuthGuard)
  @Get('memory')
  async getMemory() {
    const profile = await this.hardwareInspector.getProfile();
    return this.memoryManager.calculateBudget(profile);
  }

  @UseGuards(AuthGuard)
  @Get('models/catalog')
  async getCatalog() {
    const profile = await this.hardwareInspector.getProfile();
    return {
      tier: profile.tier,
      recommended: this.modelRegistry.getRecommendedModels(profile.tier),
      available: this.modelRegistry.getModelsForTier(profile.tier),
    };
  }

  @UseGuards(AuthGuard)
  @Get('models/tracked')
  async getTrackedModels() {
    return this.modelRegistry.getTrackedModels();
  }

  @UseGuards(AuthGuard)
  @Post('models/pull')
  async pullModel(@Body() body: { modelId: string }) {
    await this.modelPuller.pullModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} pulled` };
  }

  @UseGuards(AuthGuard)
  @Post('models/load')
  async loadModel(@Body() body: { modelId: string }) {
    await this.modelPuller.loadModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} loaded` };
  }

  @UseGuards(AuthGuard)
  @Post('models/unload')
  async unloadModel(@Body() body: { modelId: string }) {
    await this.modelPuller.unloadModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} unloaded` };
  }

  @UseGuards(AuthGuard)
  @Post('models/pin')
  async pinModel(@Body() body: { modelId: string }) {
    const profile = await this.hardwareInspector.getProfile();
    const curated = this.modelRegistry.getCuratedModel(body.modelId);
    const footprint = curated?.runtime.memoryFootprintMb || 0;
    const canPin = this.memoryManager.canPinModel(profile, footprint);

    if (!canPin.canPin) {
      return { success: false, message: canPin.reason };
    }

    // Ensure model is loaded before pinning
    const tracked = this.modelRegistry.getTrackedModel(body.modelId);
    if (!tracked || (tracked.state !== 'loaded' && tracked.state !== 'pinned')) {
      await this.modelPuller.loadModel(body.modelId);
    }

    this.modelRegistry.pinModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} pinned` };
  }

  @UseGuards(AuthGuard)
  @Post('models/unpin')
  async unpinModel(@Body() body: { modelId: string }) {
    this.modelRegistry.unpinModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} unpinned` };
  }

  @UseGuards(AuthGuard)
  @Get('cloud-providers')
  async getCloudProviders() {
    return this.cloudFallback.listProviders().map((p) => ({
      provider: p.provider,
      enabled: p.enabled,
      configured: !!p.apiKey,
      defaultModel: p.defaultModel,
    }));
  }

  @UseGuards(AuthGuard)
  @Post('cloud-providers')
  async setCloudProvider(@Body() body: { provider: CloudProviderType; apiKey: string; enabled: boolean; baseUrl?: string; defaultModel?: string }) {
    this.cloudFallback.setProvider({
      provider: body.provider,
      apiKey: body.apiKey,
      enabled: body.enabled,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel || this.cloudFallback.getDefaultModel(body.provider),
    });
    return { success: true };
  }

  // ─── Onboarding Aggregated Endpoint ───────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('onboarding-profile')
  async getOnboardingProfile() {
    const profile = await this.hardwareInspector.getProfile();
    const tier = profile.tier;
    const recommendedModels = this.modelRegistry.getRecommendedModels(tier);
    const availableModels = this.modelRegistry.getModelsForTier(tier);
    const budget = this.memoryManager.calculateBudget(profile);
    const status = await this.router.getStatus();

    const recommendedBackend: string = profile.gpu.vendor === 'nvidia' && profile.gpu.runtimeAvailable ? 'vllm' : 'ollama';

    const totalMemoryMb = recommendedModels.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);
    const availableMemoryMb =
      profile.gpu.available && !profile.gpu.unifiedMemory
        ? budget.modelBudgetVramMb - budget.modelUsedVramMb
        : budget.modelBudgetRamMb - budget.modelUsedRamMb;

    return {
      hardware: profile,
      tier,
      recommendedModels,
      availableModels,
      memoryBudget: budget,
      backends: {
        recommended: recommendedBackend,
        available: status.backends.map((b) => ({ type: b.type, running: b.running, healthy: b.healthy })),
      },
      resourceEstimate: {
        totalDiskMb: recommendedModels.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0),
        totalMemoryMb,
        availableMemoryMb: Math.max(0, availableMemoryMb),
      },
    };
  }
}
