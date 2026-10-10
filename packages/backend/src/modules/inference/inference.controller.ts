import {
  Body,
  Controller,
  ConflictException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  forwardRef,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { PoolProxyService } from '@/modules/hub-pool/hub-pool-proxy.service';
import { POOL_SESSION_HEADER } from '@/modules/hub-pool/hub-pool-prefix-affinity';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { TranslatableError } from '@/common/error/translatable-error';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { InferenceRouterService } from './inference-router.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { MemoryManagerService } from './memory-manager.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelResidencyService } from './model-residency.service';
import { reconcileTrackedWithResidency } from './tracked-residency';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaInstallerService } from './ollama-installer.service';
import { RocmInstallerService } from './rocm-installer.service';
import { AppContainerOriginGuard } from './app-container-origin.guard';
import { AppCredentialsService } from './app-credentials.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { InferenceAccessGuard } from '@/modules/auth/inference-access.guard';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { CloudProviderType, HardwareProfile, HardwareTier, InferenceBackendType } from '@ci-hub/common/types';
import {
  RuntimeModelsQueryDto,
  UpdateInferencePreferencesBody,
  UpdateRocmInstallStateBody,
  OnboardingProfileQueryDto,
  VllmStatusQueryDto,
  OmlxStatusQueryDto,
  ManualEndpointStatusQueryDto,
} from './inference.dto';
import { InferenceBackendRegistry } from './backends/backend-registry';
import { OllamaBackend } from './backends/ollama.backend';
import { buildVllmRemediation, resolveVllmProbeUrl, VLLM_PROBE_API_KEY_HEADER, VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { buildLemonadeRemediation, classifyLemonadeFailure } from './backends/lemonade-remediation';
import { resolveBridgeTopology, resolveHostPlatform } from './backends/ollama-host-bridge';
import { buildOmlxRemediation, OMLX_PROBE_API_KEY_HEADER, OmlxBackend, resolveOmlxProbeUrl } from './backends/omlx.backend';
import { OpenAiCompatibleClient } from './backends/openai-compatible.client';
import { resolveInstalledCatalogIds, resolveInstalledCatalogIdsFromServedModels, servedIdForCatalogModel } from './model-availability.util';
import { BackendObserverService } from './supervision/backend-observer.service';
import { buildTranscriptionForm, MAX_TRANSCRIPTION_BYTES, speechContentType, type UploadedAudio } from './audio-proxy.util';
import { sendRouteError } from './inference-error-reply';
import { abortWhenClientCloses, relayStream } from './upstream-stream';

/** The transcription `response_format`s that are a plain-text transcript, and the type each goes out under. */
const TRANSCRIPT_TEXT_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['text', 'text/plain; charset=utf-8'],
  ['srt', 'text/plain; charset=utf-8'],
  ['vtt', 'text/vtt; charset=utf-8'],
]);

/**
 * Inference controller — exposes Ollama/backend provisioning + management,
 * and OpenAI-compatible `/v1` proxy routes for Hub-managed apps and, with an
 * `inference` API key, for editors and SDKs (see `InferenceAccessGuard`).
 *
 * When the Hub has connected pool peers, `/v1` routes delegate to
 * `PoolProxyService.proxyRequest()` for cross-node pooled inference.
 * Otherwise they route through the local `InferenceRouterService`.
 */
@ApiTags('Inference')
@Controller('inference')
export class InferenceController {
  constructor(
    private readonly residency: ModelResidencyService,
    private readonly router: InferenceRouterService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly memoryManager: MemoryManagerService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly modelPuller: ModelPullerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly ollamaInstaller: OllamaInstallerService,
    private readonly rocmInstaller: RocmInstallerService,
    private readonly appCredentials: AppCredentialsService,
    private readonly hostMetrics: HostMetricsService,
    private readonly configurationService: ConfigurationService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
    private readonly omlxBackend: OmlxBackend,
    private readonly moduleRef: ModuleRef,
    readonly _logger: LoggerService,
    private readonly backends: InferenceBackendRegistry,
    private readonly backendObserver: BackendObserverService,
    @Inject(forwardRef(() => PoolProxyService)) private readonly poolProxy: PoolProxyService,
    @Inject(forwardRef(() => HubPoolPeerService)) private readonly poolPeers: HubPoolPeerService,
  ) {}

  private getRecommendedBackend(profile: HardwareProfile): InferenceBackendType {
    // NVIDIA with a usable runtime: vLLM. Apple Silicon: oMLX. An NPU: Lemonade.
    // Everything else, including AMD without a cited vLLM ROCm path: Ollama.
    return profile.npu.available
      ? 'lemonade'
      : profile.gpu.vendor === 'nvidia' && profile.gpu.runtimeAvailable
        ? 'vllm'
        : profile.gpu.vendor === 'apple'
          ? 'omlx'
          : 'ollama';
  }

  private getOnboardingTier(profile: HardwareProfile, recommendedBackend: InferenceBackendType): HardwareTier {
    if (
      recommendedBackend === 'ollama' &&
      profile.gpu.available &&
      !profile.gpu.unifiedMemory &&
      !profile.gpu.runtimeAvailable &&
      (profile.gpu.vendor === 'nvidia' || profile.gpu.vendor === 'amd') &&
      profile.gpu.vramMb > 0
    ) {
      return this.hardwareInspector.computeTier({ ...profile.gpu, runtimeAvailable: true }, profile.ram);
    }

    return profile.tier;
  }

  /**
   * Bring running AI apps up to date after an inference config change, through the same service
   * `PATCH /api/user-settings` uses — it debounces bursts and restarts only apps whose env is stale.
   * The credentials cache is dropped here as well, synchronously, so a failed lookup of the refresh
   * service cannot leave apps bootstrapping from a 30 s-old answer.
   */
  private scheduleAiAppRestart(reason: string): void {
    this.appCredentials.invalidateCache();
    void this.requestInferenceEnvRefresh(reason);
  }

  private async requestInferenceEnvRefresh(reason: string): Promise<void> {
    try {
      // Lazy: AppLifecycleModule imports InferenceModule, so a static edge back would be a cycle.
      const { AiAppInferenceRefreshService } = await import('../app-lifecycle/ai-app-inference-refresh.service');
      this.moduleRef.get(AiAppInferenceRefreshService, { strict: false })?.requestRefresh(reason);
    } catch (e) {
      this._logger.error('Failed to request an AI app inference refresh after an inference config update', e);
    }
  }

  // ─── OpenAI-compatible v1 proxy ─────────────────────────────────────
  // Two audiences, one guard. Apps set HUB_INFERENCE_URL to
  // http://<hub>:<port>/api/inference/v1 and reach it container-to-container,
  // which InferenceAccessGuard admits by origin with no credential read. An
  // editor or SDK (Continue, Zed, Aider, the OpenAI Python client) points its
  // base URL here from anywhere — LAN, tailnet, or the public hostname — and
  // is admitted by origin where it can be placed inside, and by an `inference`
  // API key everywhere else. When pool peers are connected, requests
  // auto-upgrade to cross-node pooled routing via PoolProxyService. Otherwise,
  // the local InferenceRouterService handles them directly. Refusals are
  // OpenAI-shaped (`{ error: { message, type, code } }`) like every error these
  // handlers emit themselves, so a client shows the reason, not a Nest envelope.
  // On the local path an engine's own refusal keeps its status and message, and
  // only a failure to get any answer is a 502 — see `inference-error-reply.ts`.
  //
  // `@HttpCode(200)` on every POST here: Nest sets a POST's default 201 on the
  // response before the handler runs, `@Res()` or not, so a local success went
  // out as `201 Created` (beta-red, 2026-09-29). OpenAI answers 200, and strict
  // clients check for it. The pool path sets the upstream's own status and is
  // unaffected.
  //
  // A client that leaves takes its upstream request with it: `clientClosed` rides
  // to the engine or cloud call, and a stream is relayed with `relayStream`
  // rather than `pipe`, which never destroyed its source. Before this an app or
  // editor that disconnected mid-stream left the Hub holding the provider's
  // connection, still generating, for as long as the provider kept it open.

  @UseGuards(InferenceAccessGuard)
  @Post('v1/chat/completions')
  @HttpCode(200)
  async v1ChatCompletions(@Body() body: Record<string, unknown>, @Res() res: Response, @Headers(POOL_SESSION_HEADER) session?: string | string[]) {
    const model = (body.model as string) || 'auto';
    if (await this.poolPeers.hasConnectedPeers()) {
      // The session header rides through so an app on this route gets prefix affinity too — see
      // `hub-pool-prefix-affinity.ts`. The peerless path below serves locally and needs no hint.
      return this.poolProxy.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body, model, res, sessionHeader: session });
    }
    const clientClosed = abortWhenClientCloses(res);
    try {
      const result = await this.router.routeChatCompletion(body, clientClosed);
      if (result.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (result.headers) {
          for (const [key, value] of Object.entries(result.headers)) {
            res.setHeader(key, value);
          }
        }
        relayStream(result.stream, res);
      } else {
        res.json(result.data);
      }
    } catch (err) {
      await sendRouteError(res, err);
    }
  }

  @UseGuards(InferenceAccessGuard)
  @Post('v1/completions')
  @HttpCode(200)
  async v1Completions(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const model = (body.model as string) || 'auto';
    if (await this.poolPeers.hasConnectedPeers()) {
      return this.poolProxy.proxyRequest({ path: '/v1/completions', method: 'POST', body, model, res });
    }
    const clientClosed = abortWhenClientCloses(res);
    try {
      const result = await this.router.routeCompletion(body, clientClosed);
      if (result.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (result.headers) {
          for (const [key, value] of Object.entries(result.headers)) {
            res.setHeader(key, value);
          }
        }
        relayStream(result.stream, res);
      } else {
        res.json(result.data);
      }
    } catch (err) {
      await sendRouteError(res, err);
    }
  }

  @UseGuards(InferenceAccessGuard)
  @Post('v1/embeddings')
  @HttpCode(200)
  async v1Embeddings(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const model = (body.model as string) || '';
    if (await this.poolPeers.hasConnectedPeers()) {
      return this.poolProxy.proxyRequest({ path: '/v1/embeddings', method: 'POST', body, model, res });
    }
    const clientClosed = abortWhenClientCloses(res);
    try {
      const result = await this.router.routeEmbeddings(body, clientClosed);
      res.json(result.data);
    } catch (err) {
      await sendRouteError(res, err);
    }
  }

  @UseGuards(InferenceAccessGuard)
  @Get('v1/models')
  async v1Models(@Res() res: Response) {
    try {
      const models = await this.router.listModels();
      res.json({ object: 'list', data: models });
    } catch (err) {
      await sendRouteError(res, err);
    }
  }

  @UseGuards(InferenceAccessGuard)
  @Post('v1/audio/speech')
  @HttpCode(200)
  async v1AudioSpeech(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      const result = await this.router.routeTts(body);
      res.setHeader('Content-Type', speechContentType(body));
      res.send(result.data);
    } catch (err) {
      await sendRouteError(res, err);
    }
  }

  @UseGuards(InferenceAccessGuard)
  @Post('v1/audio/transcriptions')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_TRANSCRIPTION_BYTES } }))
  async v1AudioTranscriptions(@UploadedFile() file: UploadedAudio | undefined, @Body() body: Record<string, unknown>, @Res() res: Response) {
    // OpenAI clients send multipart/form-data with the audio in `file`.
    if (!file) {
      res.status(400).json({
        error: {
          message: "Send the audio as multipart/form-data in a field named 'file'.",
          type: 'invalid_request_error',
          code: 'missing_file',
        },
      });
      return;
    }
    try {
      const result = await this.router.routeStt(buildTranscriptionForm(file, body));
      // `response_format` text, srt and vtt are plain-text transcripts, not JSON. Sent through
      // `res.json` they came back as a quoted string labelled application/json, which an SDK asking
      // for text returns with the quotes and escapes still in it (#1643). A JSON-looking transcript
      // ("42") has already been parsed by axios on the way in, hence the `String`.
      const textType = typeof body.response_format === 'string' ? TRANSCRIPT_TEXT_CONTENT_TYPES.get(body.response_format) : undefined;
      if (textType && (typeof result.data !== 'object' || result.data === null)) {
        res.setHeader('Content-Type', textType);
        res.send(String(result.data ?? ''));
      } else {
        res.json(result.data);
      }
    } catch (err) {
      await sendRouteError(res, err);
    }
  }

  // ─── Health ───────────────────────────────────────────────────────────

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
  @Get('preferences')
  async getPreferences() {
    return this.configurationService.getInferencePreferences();
  }

  @UseGuards(AuthGuard)
  @Patch('preferences')
  async updatePreferences(@Body() body: UpdateInferencePreferencesBody) {
    const result = await this.configurationService.setInferencePreferences(
      body.backend,
      body.model,
      body.embeddingModel,
      body.visionModel,
      body.vllmApiKey,
      body.vllmUrl,
      body.omlxUrl,
      body.decodeEndpoint,
      body.encodeEndpoint,
      body.maxNumCtx,
      body.ollamaSlots,
    );

    this.scheduleAiAppRestart('inference preferences changed');

    return result;
  }

  /**
   * What is IN MEMORY right now, per backend.
   *
   * Distinct from `models/runtime`, which reports the on-disk inventory: on a live node those
   * two disagree completely — 11 models listed, zero resident. Callers that want to know
   * whether a request will be fast, or what is occupying VRAM, need this one.
   *
   * Read `source` before `models`. `models: null` means the engine could not be asked
   * (`unreachable`) or has no residency concept (`unsupported`); only `source: 'measured'`
   * with an empty array means "asked, and nothing is loaded".
   */
  @UseGuards(AuthGuard)
  @Get('models/resident')
  async getResidentModels() {
    return this.residency.getReport(new Date().toISOString());
  }

  @UseGuards(AuthGuard)
  @Get('models/runtime')
  async getRuntimeModels(@Query() query: RuntimeModelsQueryDto) {
    const backend = query.backend;
    const backendService = this.backends.get(backend);

    const health = await backendService.healthCheck();
    if (!health.running || !health.healthy) {
      return {
        backend,
        discoveryUnavailable: true,
        models: [],
      };
    }

    const models = await backendService.listModels();
    // `state` stays the on-disk inventory. `resident` is the engine's own residency read, so a
    // downloaded row can offer Load or Unload without treating every file on disk as in memory.
    const residency = backendService.listResident
      ? await Promise.resolve()
          .then(() => backendService.listResident?.())
          .catch(() => null)
      : null;
    const residentIds = new Set(residency?.source === 'measured' ? (residency.models ?? []).map((model) => model.id) : []);

    return {
      backend,
      discoveryUnavailable: false,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        /*
         * `available`, NOT `loaded`.
         *
         * `InferenceModel.loaded` is hardcoded `true` by every backend's `listModels()`
         * (ollama.backend.ts, lemonade.backend.ts, openai-compatible.client.ts) — it has never
         * meant "resident in VRAM", only "the engine has this in its inventory". Reporting it as `loaded` borrowed a word from
         * the `ModelState` lifecycle, where `loaded` is specifically the resident state and
         * `pulled` is the on-disk one, so the route asserted residency it never measured.
         *
         * Measured on beta-max: this route reported 11/11 `loaded` while the engine's own
         * `/api/ps` reported zero models resident. `resident` is that measurement. `state` stays
         * the inventory word.
         */
        state: model.loaded ? 'available' : 'unknown',
        resident: residentIds.has(model.id),
      })),
    };
  }

  @UseGuards(AuthGuard)
  @Get('status')
  async getStatus() {
    return this.router.getStatus();
  }

  /**
   * What the Hub can see about each inference backend's *process*, and any container the local
   * Docker daemon is restarting in a loop.
   *
   * Read-only in the strongest sense available: there is no companion POST. The Hub never restarts,
   * stops or starts an inference backend, so there is no action for this route to offer — see
   * `common/helpers/inference-supervision.ts` for why that is the feature rather than a gap. The
   * report is served from memory and issues no probe of its own; when
   * `inferenceSupervisionMode` is `'off'` (the default) it reports exactly that, with no
   * observations behind it.
   */
  @UseGuards(AuthGuard)
  @Get('supervision')
  getSupervision() {
    return this.backendObserver.getReport();
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
  @Get('rocm/status')
  async getRocmStatus() {
    return this.rocmInstaller.getStatus();
  }

  @UseGuards(AuthGuard)
  @Post('rocm/install-state')
  async updateRocmInstallState(@Body() body: UpdateRocmInstallStateBody) {
    await this.rocmInstaller.recordInstallState({
      phase: body.phase,
      updatedAt: new Date().toISOString(),
      message: body.message,
    });
    return this.rocmInstaller.getStatus();
  }

  @UseGuards(AuthGuard)
  @Get('memory')
  async getMemory() {
    const profile = await this.hardwareInspector.getProfile();
    return await this.memoryManager.calculateBudget(profile);
  }

  @UseGuards(AuthGuard)
  @Get('models/catalog')
  async getCatalog() {
    const profile = await this.hardwareInspector.getProfile();
    return {
      tier: profile.tier,
      recommended: this.modelRegistry.getRecommendedModelsForHardware(profile.tier, profile),
      available: this.modelRegistry.getModelsForHardware(profile.tier, profile),
    };
  }

  @UseGuards(AuthGuard)
  @Get('models/tracked')
  async getTrackedModels() {
    // Agree with the engines first: a model Lemonade or Ollama loaded on its own (at boot, or for a
    // request) is resident whether or not this process ever tracked it. See tracked-residency.ts.
    const residency = await this.residency.getReport(new Date().toISOString());
    for (const change of reconcileTrackedWithResidency({
      catalog: this.modelRegistry.getCatalog() ?? [],
      tracked: this.modelRegistry.getTrackedModels(),
      residency,
    })) {
      if (this.modelRegistry.getTrackedModel(change.catalogId)) this.modelRegistry.updateModelState(change.catalogId, change.state);
      else this.modelRegistry.trackModel(change.catalogId, change.state);
    }
    return this.modelRegistry.getTrackedModels();
  }

  @UseGuards(AuthGuard, DemoModeGuard)
  @Post('models/pull/start')
  async startPullModel(@Body() body: { modelId: string; bestEffort?: boolean }) {
    if (!body.modelId?.trim()) {
      throw new TranslatableError('INFERENCE_ERROR_MODEL_ID_REQUIRED');
    }
    return this.modelPuller.startPull(body.modelId.trim(), { bestEffort: body.bestEffort });
  }

  @UseGuards(AuthGuard, DemoModeGuard)
  @Post('models/pull')
  async pullModel(@Body() body: { modelId: string; bestEffort?: boolean }) {
    const result = await this.modelPuller.startPull(body.modelId, { bestEffort: body.bestEffort });
    if (result.status === 'already_installed') {
      return { success: true, message: `Model ${body.modelId} already installed` };
    }
    if (result.status === 'skipped') {
      return { success: false, skipped: true, message: result.reason ?? `Pull blocked for ${body.modelId}` };
    }
    if (result.status === 'error') {
      throw new ConflictException(result.reason ?? `Pull blocked for ${body.modelId}`);
    }

    try {
      await this.modelPuller.waitForPullCompletion(body.modelId);
      return { success: true, message: `Model ${body.modelId} pulled` };
    } catch (err) {
      const curated = this.modelRegistry.getCuratedModel(body.modelId);
      const msg = err instanceof Error ? err.message : String(err);
      if (body.bestEffort && curated?.backend === 'ollama') {
        this._logger.warn(`[Inference] Best-effort Ollama pull skipped for ${body.modelId}: ${msg}`);
        return { success: false, skipped: true, message: msg };
      }
      throw err;
    }
  }

  /**
   * A catalog id for `modelId`, which may already be one or may be the engine's spelling of one
   * (`backendModelId`, or Lemonade's `user.` form). Null when the file is only in the engine.
   */
  private catalogIdForEngineModel(modelId: string): string | null {
    if (this.modelRegistry.getCuratedModel(modelId)) return modelId;
    const catalog = this.modelRegistry.getCatalog() ?? [];
    return catalog.find((model) => servedIdForCatalogModel(model, [modelId]))?.id ?? null;
  }

  /** True when this resident id is an embedder, so the status card does not present it as the chat model. */
  private isEmbeddingResident(modelId: string): boolean {
    if (/embed/i.test(modelId)) return true;
    const catalog = this.modelRegistry.getCatalog() ?? [];
    return catalog.some((model) => model.modality !== 'llm' && (model.id === modelId || model.backendModelId === modelId));
  }

  @UseGuards(AuthGuard)
  @Post('models/load')
  async loadModel(@Body() body: { modelId: string; backend?: InferenceBackendType }) {
    const catalogId = this.catalogIdForEngineModel(body.modelId);
    if (catalogId) {
      // Through the router, like a pin: it makes room, sizes the context window and refuses a load
      // that cannot fit, where the engine's own load would go on top of whatever holds the card.
      // `operator`: AuthGuard admits only a signed-in operator or a host-local credential acting as
      // one, never an app's key, so this load may unload any idle model — an app's included — and
      // the Hub picks its window.
      const outcome = await this.router.loadTrackedModel(catalogId, { origin: 'operator' });
      if (!outcome.loaded) {
        return { success: false, message: outcome.reason };
      }
      return { success: true, message: `Model ${catalogId} loaded` };
    }

    // A file the engine downloaded under a name the catalog does not have. Lemonade keeps the
    // window that was saved with the file; the Hub has no footprint for it, so this does not run
    // the catalog fit. The engine still replaces its other chat model when it only holds one.
    if (!body.backend) {
      return { success: false, message: `Model ${body.modelId} is not in the catalog` };
    }
    const backend = this.backends.get(body.backend);
    const listed = ((await Promise.resolve()
      .then(() => backend.listModels())
      .catch(() => [])) ?? []) as { id: string }[];
    if (!listed.some((model) => model.id === body.modelId)) {
      return { success: false, message: `${body.modelId} is not downloaded on ${body.backend}` };
    }
    await backend.loadModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} loaded` };
  }

  @UseGuards(AuthGuard)
  @Post('models/unload')
  async unloadModel(@Body() body: { modelId: string; backend?: InferenceBackendType }) {
    const catalogId = this.catalogIdForEngineModel(body.modelId);
    if (catalogId) {
      await this.modelPuller.unloadModel(catalogId);
      return { success: true, message: `Model ${catalogId} unloaded` };
    }
    if (!body.backend) {
      return { success: false, message: `Model ${body.modelId} is not in the catalog` };
    }
    await this.backends.get(body.backend).unloadModel(body.modelId);
    return { success: true, message: `Model ${body.modelId} unloaded` };
  }

  @UseGuards(AuthGuard)
  @Post('models/pin')
  async pinModel(@Body() body: { modelId: string }) {
    // Through the router's load path, so the pin fits, evicts or refuses exactly as a load does
    // instead of loading on top of the card, then checks the pinned-model budget against what the
    // model was measured occupying here. `operator` for the same reason as the load above: a pin
    // may clear an idle model an app loaded.
    const outcome = await this.router.pinTrackedModel(body.modelId, { origin: 'operator' });
    if (!outcome.pinned) {
      return { success: false, message: outcome.reason };
    }
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
  async setCloudProvider(@Body() body: { provider: CloudProviderType; apiKey?: string; enabled: boolean; baseUrl?: string; defaultModel?: string }) {
    await this.cloudFallback.setProvider({
      provider: body.provider,
      apiKey: body.apiKey,
      enabled: body.enabled,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel || this.cloudFallback.getDefaultModel(body.provider),
    });
    this.scheduleAiAppRestart(`cloud provider ${body.provider} changed`);
    return { success: true };
  }

  // ─── Onboarding Aggregated Endpoint ───────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('onboarding-profile')
  @ApiHeader({ name: VLLM_PROBE_API_KEY_HEADER, required: false, description: 'Unsaved vLLM API key for Re-check before Save.' })
  @ApiHeader({ name: OMLX_PROBE_API_KEY_HEADER, required: false, description: 'Unsaved oMLX API key for Re-check before Save.' })
  async getOnboardingProfile(
    @Query() query: OnboardingProfileQueryDto,
    @Headers(VLLM_PROBE_API_KEY_HEADER) vllmApiKey?: string,
    @Headers(OMLX_PROBE_API_KEY_HEADER) omlxApiKey?: string,
  ) {
    const profile = await this.hardwareInspector.getProfile();
    const recommendedBackend = this.getRecommendedBackend(profile);
    const installBackend = query?.backend ?? recommendedBackend;
    const tier = this.getOnboardingTier(profile, recommendedBackend);
    // Probed before the model lists, not after: the probe reads Lemonade's registry, which decides
    // which Lemonade rows the lists below may offer (ModelRegistryService.getModelsForTier).
    const lemonadeHealth =
      installBackend === 'lemonade'
        ? await this.lemonadeBackend.healthCheck().catch(() => ({ running: false, healthy: false, modelsLoaded: [] as string[] }))
        : null;
    const recommendedModels = this.modelRegistry.getRecommendedModelsForHardware(tier, profile);
    // Keep rows for an explicitly selected host-served backend visible even when its server lives
    // on another OS (for example, a Linux Hub pointing at a Mac's Speculative inference endpoint).
    // Automatic recommendations remain local-platform-aware; this exception only preserves remote
    // endpoint configuration and lets the live probe decide what that server actually serves.
    const availableModels = this.modelRegistry.getModelsForHardware(tier, profile, { includeRemoteHostBackends: true });
    const budget = await this.memoryManager.calculateBudget(profile);
    const status = await this.router.getStatus();

    const totalMemoryMb = recommendedModels.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);
    const availableMemoryMb =
      profile.gpu.available && !profile.gpu.unifiedMemory
        ? budget.modelBudgetVramMb - budget.modelUsedVramMb
        : budget.modelBudgetRamMb - budget.modelUsedRamMb;

    const hostSection = await this.hostMetrics.readHostSection();
    const displayLoad = await this.hostMetrics.getDisplayLoad(0, 0);
    const diskTotalGb = hostSection && hostSection.diskTotalGb > 0 ? hostSection.diskTotalGb : displayLoad.diskSize;
    const diskUsedGb = hostSection && hostSection.diskTotalGb > 0 ? hostSection.diskUsedGb : displayLoad.diskUsed;
    const diskTotalMb = diskTotalGb * 1024;
    const availableDiskMb = Math.max(0, (diskTotalGb - diskUsedGb) * 1024);

    const catalog = this.modelRegistry.getCatalog();
    const getTrackedState = (id: string) => this.modelRegistry.getTrackedModel(id)?.state;

    const ollamaHealth = await this.ollamaBackend.healthCheck().catch(() => ({
      running: false,
      healthy: false,
      modelsLoaded: [] as string[],
    }));
    const ollamaInstalled = resolveInstalledCatalogIds(catalog, ollamaHealth.modelsLoaded ?? [], getTrackedState);

    let installedCatalogIds: string[];
    // Lemonade exposes the same model registry surface as its load/pull API, while vLLM and oMLX
    // are host-run servers with no Hub-side pull registry. Read each backend's live model ids so
    // the model picker reflects what the selected endpoint can actually serve. Ollama's embedding
    // rows are merged for host-served chat backends because embeddings stay on Ollama there.
    // vLLM and oMLX probes take an optional API key override; the other probes only take a URL.
    if (lemonadeHealth) {
      installedCatalogIds = resolveInstalledCatalogIdsFromServedModels(catalog, lemonadeHealth.modelsLoaded ?? [], 'lemonade', getTrackedState);
    } else if (installBackend === 'vllm' || installBackend === 'omlx') {
      const servedHealth =
        installBackend === 'omlx'
          ? await this.omlxBackend.healthCheck(query?.omlxUrl, omlxApiKey).catch(() => ({
              running: false,
              healthy: false,
              modelsLoaded: [] as string[],
            }))
          : await this.vllmBackend.healthCheck(query?.vllmUrl, vllmApiKey).catch(() => ({
              running: false,
              healthy: false,
              modelsLoaded: [] as string[],
            }));
      const servedInstalled = resolveInstalledCatalogIdsFromServedModels(catalog, servedHealth.modelsLoaded ?? [], installBackend, getTrackedState);
      const ollamaEmbeddingIds = ollamaInstalled.filter((id) => {
        const model = catalog.find((m) => m.id === id);
        return model?.modality === 'embedding';
      });
      installedCatalogIds = [...new Set([...servedInstalled, ...ollamaEmbeddingIds])];
    } else {
      installedCatalogIds = ollamaInstalled;
    }

    return {
      hardware: profile,
      tier,
      recommendedModels,
      availableModels,
      installedCatalogIds,
      memoryBudget: budget,
      backends: {
        recommended: recommendedBackend,
        available: status.backends.map((b) => ({ type: b.type, running: b.running, healthy: b.healthy })),
      },
      resourceEstimate: {
        totalDiskMb: recommendedModels.reduce((sum, m) => sum + m.requirements.diskMb, 0),
        totalMemoryMb,
        availableMemoryMb: Math.max(0, availableMemoryMb),
        availableDiskMb,
        diskTotalMb: diskTotalMb,
      },
    };
  }

  // ─── Ollama Installation ──────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('ollama/status')
  async getOllamaStatus() {
    return this.ollamaInstaller.checkInstallation();
  }

  /** Probe the configured Lemonade server through its official /v1/health route. */
  @UseGuards(AuthGuard)
  @Get('lemonade/status')
  async getLemonadeStatus() {
    const endpointUrl = this.lemonadeBackend.getBaseUrl();
    const health = await this.lemonadeBackend.healthCheck().catch((err) => ({
      running: false,
      healthy: false,
      modelsLoaded: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    }));
    const ready = !!(health.running && health.healthy);
    const apiKeyConfigured = Boolean(this.lemonadeBackend.getApiKey());
    if (ready) {
      // `loadedModels` is the download inventory. `residentModels` is what Lemonade is actually
      // holding, so the status card does not present the first downloaded name as the chosen model.
      const residency = await Promise.resolve()
        .then(() => this.lemonadeBackend.listResident())
        .catch(() => null);
      const measured =
        residency?.source === 'measured' ? (residency.models ?? []).map((model) => model.id).filter((id) => id && id !== 'unknown') : [];
      // Lemonade lists the embedder ahead of the chat model. The card shows the first id, so an
      // embedding-only reading hid the coder the operator just loaded.
      const residentModels = [...measured].sort((a, b) => Number(this.isEmbeddingResident(a)) - Number(this.isEmbeddingResident(b)));
      return {
        ready,
        running: health.running,
        endpointUrl,
        displayEndpoint: `${endpointUrl}/v1`,
        loadedModels: health.modelsLoaded,
        residentModels,
        apiKeyConfigured,
      };
    }
    // What failed and what the host runs, so the card shows the fix for this host instead of one
    // Linux recipe for every failure: no `systemctl` on macOS, no rebind for a refused key, and
    // firewall rules for the firewall the host probe found.
    const failureMode = classifyLemonadeFailure(health.error, endpointUrl);
    const hostProbe = await this.hostMetrics.readHostProbe().catch(() => null);
    const hostPlatform = hostProbe?.platform ?? resolveHostPlatform();
    const topology = failureMode === 'auth' || failureMode === 'dns' ? undefined : await resolveBridgeTopology(endpointUrl);
    const remediation = buildLemonadeRemediation({ mode: failureMode, hostPlatform, firewall: hostProbe?.firewall, topology, apiKeyConfigured });
    return {
      ready,
      running: health.running,
      endpointUrl,
      loadedModels: health.modelsLoaded,
      error: health.error,
      failureMode,
      hostPlatform,
      apiKeyConfigured,
      firewallCommands: remediation.firewallCommands,
      hint:
        remediation.hint ??
        'Start the Lemonade server on the host, then re-check this connection. The Hub will pull and load selected models through Lemonade’s API.',
    };
  }

  @UseGuards(AuthGuard)
  @Get('vllm/status')
  @ApiHeader({ name: VLLM_PROBE_API_KEY_HEADER, required: false, description: 'Unsaved vLLM API key for Re-check before Save.' })
  async getVllmStatus(@Query() query?: VllmStatusQueryDto, @Headers(VLLM_PROBE_API_KEY_HEADER) apiKey?: string) {
    const requestedUrl = query?.url?.trim() || this.vllmBackend.getBaseUrl();
    const probeUrl = resolveVllmProbeUrl(requestedUrl);
    const health = await this.vllmBackend.healthCheck(requestedUrl, apiKey).catch((err) => ({
      running: false,
      healthy: false,
      modelsLoaded: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    }));
    const ready = !!(health.running && health.healthy);
    const displayEndpoint = ready ? `${probeUrl}/v1` : undefined;
    const remediation = ready ? undefined : buildVllmRemediation();
    return {
      ready,
      running: health.running,
      endpointUrl: probeUrl,
      displayEndpoint,
      remediationCommand: remediation?.command,
      error: ready ? undefined : health.error,
      hint: remediation
        ? `${remediation.hint} Hub probes from inside its container — use http://host.docker.internal:8000, not localhost. Currently probing ${probeUrl}.`
        : undefined,
    };
  }

  @UseGuards(AuthGuard)
  @Get('omlx/status')
  @ApiHeader({ name: OMLX_PROBE_API_KEY_HEADER, required: false, description: 'Unsaved oMLX API key for Re-check before Save.' })
  async getOmlxStatus(@Query() query?: OmlxStatusQueryDto, @Headers(OMLX_PROBE_API_KEY_HEADER) apiKey?: string) {
    const requestedUrl = query?.url?.trim() || this.omlxBackend.getBaseUrl();
    const probeUrl = resolveOmlxProbeUrl(requestedUrl);
    const health = await this.omlxBackend.healthCheck(requestedUrl, apiKey).catch((err) => ({
      running: false,
      healthy: false,
      modelsLoaded: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    }));
    const ready = !!(health.running && health.healthy);
    const remediation = ready ? undefined : buildOmlxRemediation();
    return {
      ready,
      running: health.running,
      endpointUrl: probeUrl,
      displayEndpoint: ready ? `${probeUrl}/v1` : undefined,
      loadedModels: health.modelsLoaded,
      remediationCommand: remediation?.command,
      error: ready ? undefined : health.error,
      hint: remediation
        ? `${remediation.hint} Hub probes from inside its container — use http://host.docker.internal:8000, not localhost. Currently probing ${probeUrl}.`
        : undefined,
    };
  }

  /** Re-check a manual decode or encode endpoint. The URL in the response is the URL that was probed. */
  @UseGuards(AuthGuard)
  @Get('manual-endpoint/status')
  async getManualEndpointStatus(@Query() query: ManualEndpointStatusQueryDto) {
    const probeUrl = resolveOmlxProbeUrl(query.url.trim());
    const health = await new OpenAiCompatibleClient().healthCheck(probeUrl, { timeout: 5000 });
    return {
      ready: !!(health.running && health.healthy),
      running: health.running,
      endpointUrl: probeUrl,
      displayEndpoint: health.healthy ? `${probeUrl}/v1` : undefined,
      error: health.healthy ? undefined : health.error,
    };
  }

  @UseGuards(AuthGuard)
  @Post('ollama/install')
  async installOllama() {
    return this.ollamaInstaller.install();
  }

  // ─── App Credentials ──────────────────────────────────────────────────
  // Hub-managed sibling apps may query these endpoints to discover backend
  // connection info. What comes back is pool-aware: once this Hub has a
  // connected peer, the endpoint handed out is this node's pool proxy, the
  // same override the generated app.env carries (both go through
  // InferenceEndpointService). Apps can also use the v1 proxy routes above
  // (mounted at /api/inference/v1), which pool the same way.
  //
  // App-only, no credential accepted. Apps fetch these container-to-container,
  // which traverses no proxy, and the body can carry a configured cloud
  // provider's API key — so AppContainerOriginGuard admits a request only from
  // an address a running container of the slug's own app holds (with the
  // origin check that refuses tunnel or forwarded-hop provenance as its outer
  // layer). Origin alone let any installed app, LAN host or tailnet peer read
  // it; InternalNetworkGuard alone once answered it from the public internet.

  @UseGuards(AppContainerOriginGuard)
  @Get('apps/:slug/credentials')
  async getAppCredentials(@Param('slug') slug: string, @Query('v') v: string | undefined, @Res() res: Response) {
    const apiVersion = this.appCredentials.parseApiVersion(v);
    const config = await this.appCredentials.getCredentials(slug, apiVersion);
    res.setHeader('X-Hub-Credentials-Version', String(config.apiVersion));
    res.setHeader('X-Hub-Managed-Keys', config.managedKeys.join(','));
    res.setHeader('Cache-Control', 'no-store');
    res.json(config);
  }

  // `bootstrap.env` is an alias of `credentials.env`: the CI-OpenClaw / CI-Hermes bootstrap-from-hub.sh
  // scripts fetch `/api/inference/apps/:slug/bootstrap.env`, so both paths must serve the dotenv body.
  @UseGuards(AppContainerOriginGuard)
  @Get(['apps/:slug/credentials.env', 'apps/:slug/bootstrap.env'])
  async getAppCredentialsEnv(@Param('slug') slug: string, @Query('v') v: string | undefined, @Res() res: Response) {
    const apiVersion = this.appCredentials.parseApiVersion(v);
    const config = await this.appCredentials.getCredentials(slug, apiVersion);
    const body = this.appCredentials.serializeAsDotenv(config);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Hub-Credentials-Version', String(config.apiVersion));
    res.setHeader('X-Hub-Managed-Keys', config.managedKeys.join(','));
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }
}
