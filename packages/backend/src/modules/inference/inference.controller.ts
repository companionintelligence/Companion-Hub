import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InferenceRouterService } from './inference-router.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { MemoryManagerService } from './memory-manager.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { LoggerService } from '@/core/logger/logger.service';

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
      res.status(500).json({ error: { message, type: 'server_error' } });
    }
  }

  @Post('v1/completions')
  async completions(@Body() body: Record<string, unknown>, @Res() res: Response) {
    // Route through the same path as chat completions
    return this.chatCompletions(body, res);
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
      res.status(500).json({ error: { message, type: 'server_error' } });
    }
  }

  @Post('v1/audio/transcriptions')
  async stt(@Req() req: Request, @Res() res: Response) {
    try {
      // Forward the multipart form as-is
      const result = await this.router.routeStt(req.body);
      res.setHeader('X-Inference-Backend', result.backend);
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Inference] STT error: ${message}`);
      res.status(500).json({ error: { message, type: 'server_error' } });
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
      res.status(500).json({ error: { message, type: 'server_error' } });
    }
  }

  @Post('v1/images/generations')
  async imageGen(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      // Image gen only available via Lemonade or cloud
      // For now, proxy to cloud
      const provider = this.cloudFallback.getEnabledProviders()[0];
      if (!provider) {
        res.status(503).json({ error: { message: 'No image generation backend available', type: 'server_error' } });
        return;
      }
      const result = await this.cloudFallback.proxyChatCompletion(provider, body);
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { message, type: 'server_error' } });
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

  @Get('status')
  async getStatus() {
    return this.router.getStatus();
  }

  @Get('hardware')
  async getHardware() {
    return this.hardwareInspector.getProfile();
  }

  @Post('hardware/rescan')
  async rescanHardware() {
    return this.hardwareInspector.rescan();
  }

  @Get('memory')
  async getMemory() {
    const profile = await this.hardwareInspector.getProfile();
    return this.memoryManager.calculateBudget(profile);
  }

  @Get('models/catalog')
  async getCatalog() {
    const profile = await this.hardwareInspector.getProfile();
    return {
      tier: profile.tier,
      recommended: this.modelRegistry.getRecommendedModels(profile.tier),
      available: this.modelRegistry.getModelsForTier(profile.tier),
    };
  }

  @Get('models/tracked')
  async getTrackedModels() {
    return this.modelRegistry.getTrackedModels();
  }

  @Post('models/pull')
  async pullModel(@Body() body: { modelId: string }) {
    await this.modelPuller.pullModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} pulled` };
  }

  @Post('models/load')
  async loadModel(@Body() body: { modelId: string }) {
    await this.modelPuller.loadModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} loaded` };
  }

  @Post('models/unload')
  async unloadModel(@Body() body: { modelId: string }) {
    await this.modelPuller.unloadModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} unloaded` };
  }

  @Post('models/pin')
  async pinModel(@Body() body: { modelId: string }) {
    const profile = await this.hardwareInspector.getProfile();
    const curated = this.modelRegistry.getCuratedModel(body.modelId);
    const footprint = curated?.runtime.memoryFootprintMb || 0;
    const canPin = this.memoryManager.canPinModel(profile, footprint);

    if (!canPin.canPin) {
      return { success: false, message: canPin.reason };
    }

    this.modelRegistry.pinModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} pinned` };
  }

  @Post('models/unpin')
  async unpinModel(@Body() body: { modelId: string }) {
    this.modelRegistry.unpinModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} unpinned` };
  }

  @Get('cloud-providers')
  async getCloudProviders() {
    return this.cloudFallback.listProviders().map((p) => ({
      provider: p.provider,
      enabled: p.enabled,
      configured: !!p.apiKey,
      defaultModel: p.defaultModel,
    }));
  }

  @Post('cloud-providers')
  async setCloudProvider(@Body() body: { provider: string; apiKey: string; enabled: boolean; baseUrl?: string; defaultModel?: string }) {
    this.cloudFallback.setProvider({
      provider: body.provider as any,
      apiKey: body.apiKey,
      enabled: body.enabled,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel || body.provider,
    });
    return { success: true };
  }
}
