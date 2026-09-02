import { Body, Controller, ConflictException, Get, Headers, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Response } from 'express';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { TranslatableError } from '@/common/error/translatable-error';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { InferenceRouterService } from './inference-router.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { MemoryManagerService } from './memory-manager.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaInstallerService } from './ollama-installer.service';
import { RocmInstallerService } from './rocm-installer.service';
import { AppCredentialsService } from './app-credentials.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { InternalNetworkGuard } from '@/modules/auth/internal-network.guard';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { CloudProviderType, HardwareProfile, HardwareTier, InferenceBackendType } from '@ci-hub/common/types';
import {
  RuntimeModelsQueryDto,
  UpdateInferencePreferencesBody,
  UpdateRocmInstallStateBody,
  OnboardingProfileQueryDto,
  VllmStatusQueryDto,
  MtplxStatusQueryDto,
  DsparkStatusQueryDto,
  MlxStatusQueryDto,
} from './inference.dto';
import { OllamaBackend } from './backends/ollama.backend';
import { buildVllmRemediation, resolveVllmProbeUrl, VLLM_PROBE_API_KEY_HEADER, VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { buildMtplxRemediation, resolveMtplxProbeUrl, MtplxBackend } from './backends/mtplx.backend';
import { buildDsparkRemediation, DsparkBackend, resolveDsparkProbeUrl } from './backends/dspark.backend';
import { buildMlxRemediation, MlxBackend, resolveMlxProbeUrl } from './backends/mlx.backend';
import { resolveInstalledCatalogIds, resolveInstalledCatalogIdsFromServedModels } from './model-availability.util';
import type { InferenceBackend } from './backends/backend.interface';

/**
 * Inference controller — exposes Ollama/backend provisioning + management.
 *
 * The Hub does NOT proxy inference requests. Apps talk to the Ollama container
 * (its own OpenAI-compatible `/v1` or native protocol) or a cloud provider
 * directly. This controller provisions Ollama (install/pull/catalog/hardware),
 * stores the operator's cloud-provider keys, and distributes connection info to
 * apps via the credentials endpoints below.
 */
@ApiTags('Inference')
@Controller('inference')
export class InferenceController {
  constructor(
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
    private readonly mtplxBackend: MtplxBackend,
    private readonly dsparkBackend: DsparkBackend,
    private readonly mlxBackend: MlxBackend,
    private readonly moduleRef: ModuleRef,
    readonly _logger: LoggerService,
  ) {}

  /**
   * Exhaustive backend lookup. Deliberately a `switch` on the union rather than a ternary chain:
   * the previous `backend === 'ollama' ? … : backend === 'vllm' ? … : this.lemonadeBackend` shape
   * silently handed back Lemonade for any newly added backend type, and the compiler could not
   * see it. A missing `case` here is a build error instead.
   */
  private getBackendService(type: InferenceBackendType): InferenceBackend {
    switch (type) {
      case 'ollama':
        return this.ollamaBackend;
      case 'vllm':
        return this.vllmBackend;
      case 'lemonade':
        return this.lemonadeBackend;
      case 'mtplx':
        return this.mtplxBackend;
      case 'dspark':
        return this.dsparkBackend;
      case 'mlx':
        return this.mlxBackend;
    }
  }

  private getRecommendedBackend(profile: HardwareProfile): InferenceBackendType {
    // AMD GPUs (including the Strix Halo APU) always recommend Ollama, whether or not ROCm is
    // ready: its official image covers both cases — the `:rocm` tag when /dev/kfd passthrough
    // works, and the default tag (which bundles a Vulkan/RADV ggml backend that auto-activates via
    // /dev/dri) as the fallback — see OllamaBackend.getDockerImage()/.getComposeConfig(). vLLM has
    // no reliably maintained ROCm image for this hardware — see VllmBackend.getComposeConfig(),
    // which declines AMD outright rather than mount devices into an image that can't use them.
    // Apple Silicon recommends mlx-dspark (2026-08-30): like vLLM-Metal and MTPLX, it has no Docker
    // path — it's a host-run Python process (see DsparkBackend.getComposeConfig, which throws
    // unconditionally) — but unlike either of them it supports real hot-swap via POST /admin/load,
    // so the Hub can actually install/switch models into it the way it can with Ollama (see
    // isHubLoadableBackend). The install gap is a single `pip install mlx-dspark`, and
    // DsparkSetupCard already surfaces that command prominently with a live recheck when the
    // endpoint isn't reachable yet — recommending it before install just means a new Mac user sees
    // that card instead of a green one, not a dead end. vLLM-Metal and MTPLX remain opt-in only in
    // Settings: neither supports hot-swap, so the Hub can only stub their load/unload — see
    // buildVllmRemediation in vllm.backend.ts and buildMtplxRemediation in mtplx.backend.ts for the
    // guidance surfaced when either is selected.
    return profile.npu.available
      ? 'lemonade'
      : profile.gpu.vendor === 'nvidia' && profile.gpu.runtimeAvailable
        ? 'vllm'
        : profile.gpu.vendor === 'apple'
          ? 'dspark'
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

  private aiAppRestartTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Restart running AI apps after inference config changes. Debounced so a Settings
   * save that POSTs four cloud providers (then PATCH preferences) recreates
   * OpenClaw / Hermes once, not five times.
   */
  private scheduleAiAppRestart(): void {
    this.appCredentials.invalidateCache();
    if (this.aiAppRestartTimer) {
      clearTimeout(this.aiAppRestartTimer);
    }
    this.aiAppRestartTimer = setTimeout(() => {
      this.aiAppRestartTimer = undefined;
      void this.triggerAiAppRestart();
    }, 1500);
  }

  private async triggerAiAppRestart(): Promise<void> {
    try {
      const { AppLifecycleService } = await import('../app-lifecycle/app-lifecycle.service');
      const appLifecycle = this.moduleRef.get(AppLifecycleService, { strict: false });
      if (appLifecycle) {
        void appLifecycle.restartAiApps();
      }
    } catch (e) {
      this._logger.error('Failed to trigger AI app restarts after inference config update', e);
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
      body.mtplxUrl,
      body.dsparkUrl,
      body.mlxUrl,
    );

    this.scheduleAiAppRestart();

    return result;
  }

  @UseGuards(AuthGuard)
  @Get('models/runtime')
  async getRuntimeModels(@Query() query: RuntimeModelsQueryDto) {
    const backend = query.backend;
    const backendService = this.getBackendService(backend);

    const health = await backendService.healthCheck();
    if (!health.running || !health.healthy) {
      return {
        backend,
        discoveryUnavailable: true,
        models: [],
      };
    }

    const models = await backendService.listModels();

    return {
      backend,
      discoveryUnavailable: false,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        state: model.loaded ? 'loaded' : 'unknown',
      })),
    };
  }

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
    return this.memoryManager.calculateBudget(profile);
  }

  @UseGuards(AuthGuard)
  @Get('models/catalog')
  async getCatalog() {
    const profile = await this.hardwareInspector.getProfile();
    return {
      tier: profile.tier,
      recommended: this.modelRegistry.getRecommendedModelsForHardware(profile.tier, profile),
      available: this.modelRegistry.getModelsForTier(profile.tier),
    };
  }

  @UseGuards(AuthGuard)
  @Get('models/tracked')
  async getTrackedModels() {
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
  async setCloudProvider(@Body() body: { provider: CloudProviderType; apiKey?: string; enabled: boolean; baseUrl?: string; defaultModel?: string }) {
    this.cloudFallback.setProvider({
      provider: body.provider,
      apiKey: body.apiKey,
      enabled: body.enabled,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel || this.cloudFallback.getDefaultModel(body.provider),
    });
    this.scheduleAiAppRestart();
    return { success: true };
  }

  // ─── Onboarding Aggregated Endpoint ───────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('onboarding-profile')
  @ApiHeader({ name: VLLM_PROBE_API_KEY_HEADER, required: false, description: 'Unsaved vLLM API key for Re-check before Save.' })
  async getOnboardingProfile(@Query() query: OnboardingProfileQueryDto, @Headers(VLLM_PROBE_API_KEY_HEADER) vllmApiKey?: string) {
    const profile = await this.hardwareInspector.getProfile();
    const recommendedBackend = this.getRecommendedBackend(profile);
    const installBackend = query?.backend ?? recommendedBackend;
    const tier = this.getOnboardingTier(profile, recommendedBackend);
    const recommendedModels = this.modelRegistry.getRecommendedModelsForHardware(tier, profile);
    const availableModels = this.modelRegistry.getModelsForTier(tier);
    const budget = this.memoryManager.calculateBudget(profile);
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
    // Lemonade exposes the same model registry surface as its load/pull API, while vLLM, MTPLX,
    // mlx-dspark, and generic MLX-LM are host-run servers with no Hub-side pull registry. Read each
    // backend's live model ids so the model picker reflects what the selected endpoint can actually
    // serve. Ollama's embedding rows are merged for host-served chat backends because embeddings
    // stay on Ollama there. vLLM's probe takes an optional API key override; the other probes only
    // take a URL.
    if (installBackend === 'lemonade') {
      const lemonadeHealth = await this.lemonadeBackend.healthCheck().catch(() => ({
        running: false,
        healthy: false,
        modelsLoaded: [] as string[],
      }));
      installedCatalogIds = resolveInstalledCatalogIdsFromServedModels(catalog, lemonadeHealth.modelsLoaded ?? [], 'lemonade', getTrackedState);
    } else if (installBackend === 'vllm' || installBackend === 'mtplx' || installBackend === 'dspark' || installBackend === 'mlx') {
      const servedHealth =
        installBackend === 'dspark'
          ? await this.dsparkBackend.healthCheck(query?.dsparkUrl).catch(() => ({
              running: false,
              healthy: false,
              modelsLoaded: [] as string[],
            }))
          : installBackend === 'mtplx'
            ? await this.mtplxBackend.healthCheck(query?.mtplxUrl).catch(() => ({
                running: false,
                healthy: false,
                modelsLoaded: [] as string[],
              }))
            : installBackend === 'mlx'
              ? await this.mlxBackend.healthCheck(query?.mlxUrl).catch(() => ({
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
    return {
      ready,
      running: health.running,
      endpointUrl,
      displayEndpoint: ready ? `${endpointUrl}/v1` : undefined,
      loadedModels: health.modelsLoaded,
      error: ready ? undefined : health.error,
      hint: ready
        ? undefined
        : 'Start the Lemonade server on the host, then re-check this connection. The Hub will pull and load selected models through Lemonade’s API.',
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
    // Only worth a hardware lookup on the unhappy path — Apple Silicon has a completely different
    // (Docker-less, MLX-based) remediation path than everything else. See buildVllmRemediation.
    const profile = ready ? undefined : await this.hardwareInspector.getProfile().catch(() => undefined);
    const remediation = ready ? undefined : buildVllmRemediation(profile?.gpu.vendor === 'apple');
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

  /**
   * Probe the operator's mlx-dspark server. No API-key header, unlike the vLLM route: mlx-dspark
   * defaults to no key, and `GET /health` — the route DsparkBackend probes — is the one route that
   * stays auth-exempt even when a key IS configured, so this works either way.
   */
  @UseGuards(AuthGuard)
  @Get('dspark/status')
  async getDsparkStatus(@Query() query?: DsparkStatusQueryDto) {
    const requestedUrl = query?.url?.trim() || this.dsparkBackend.getBaseUrl();
    const probeUrl = resolveDsparkProbeUrl(requestedUrl);
    const health = await this.dsparkBackend.healthCheck(requestedUrl).catch((err) => ({
      running: false,
      healthy: false,
      modelsLoaded: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    }));
    const ready = !!(health.running && health.healthy);
    const displayEndpoint = ready ? `${probeUrl}/v1` : undefined;
    // Only worth a hardware lookup on the unhappy path — the remediation text differs sharply off
    // Apple Silicon, where mlx-dspark cannot run at all. See buildDsparkRemediation.
    const profile = ready ? undefined : await this.hardwareInspector.getProfile().catch(() => undefined);
    const remediation = ready ? undefined : buildDsparkRemediation(profile?.gpu.vendor === 'apple');
    return {
      ready,
      running: health.running,
      endpointUrl: probeUrl,
      displayEndpoint,
      // A reachable server with no model loaded is `ready` but serves nothing yet — the onboarding
      // card uses this to say "detected, no model loaded" rather than "detected".
      loadedModels: health.modelsLoaded,
      remediationCommand: remediation?.command,
      error: ready ? undefined : health.error,
      hint: remediation
        ? `${remediation.hint} Hub probes from inside its container — use http://host.docker.internal:8080, not localhost. Currently probing ${probeUrl}.`
        : undefined,
    };
  }

  @UseGuards(AuthGuard)
  @Get('mtplx/status')
  async getMtplxStatus(@Query() query?: MtplxStatusQueryDto) {
    const requestedUrl = query?.url?.trim() || this.mtplxBackend.getBaseUrl();
    const probeUrl = resolveMtplxProbeUrl(requestedUrl);
    const health = await this.mtplxBackend.healthCheck(requestedUrl).catch((err) => ({
      running: false,
      healthy: false,
      modelsLoaded: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    }));
    const ready = !!(health.running && health.healthy);
    const displayEndpoint = ready ? `${probeUrl}/v1` : undefined;
    const remediation = ready ? undefined : buildMtplxRemediation();
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

  /** Probe the operator's native mlx-lm OpenAI-compatible server. */
  @UseGuards(AuthGuard)
  @Get('mlx/status')
  async getMlxStatus(@Query() query?: MlxStatusQueryDto) {
    const requestedUrl = query?.url?.trim() || this.mlxBackend.getBaseUrl();
    const probeUrl = resolveMlxProbeUrl(requestedUrl);
    const health = await this.mlxBackend.healthCheck(requestedUrl).catch((err) => ({
      running: false,
      healthy: false,
      modelsLoaded: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    }));
    const ready = !!(health.running && health.healthy);
    const displayEndpoint = ready ? `${probeUrl}/v1` : undefined;
    const remediation = ready ? undefined : buildMlxRemediation();
    return {
      ready,
      running: health.running,
      endpointUrl: probeUrl,
      displayEndpoint,
      loadedModels: health.modelsLoaded,
      remediationCommand: remediation?.command,
      error: ready ? undefined : health.error,
      hint: remediation
        ? `${remediation.hint} Hub probes from inside its container — use http://host.docker.internal:8080, not localhost. Currently probing ${probeUrl}.`
        : undefined,
    };
  }

  @UseGuards(AuthGuard)
  @Post('ollama/install')
  async installOllama() {
    return this.ollamaInstaller.install();
  }

  // ─── App Credentials ──────────────────────────────────────────────────
  // Hub-managed sibling apps (currently hermes-agent and openclaw) query these endpoints
  // on container start to discover where to send inference DIRECTLY — the Ollama
  // container's OpenAI-compatible /v1 (or a cloud provider endpoint+key). The Hub
  // distributes connection info only; it never proxies the requests.

  @UseGuards(InternalNetworkGuard)
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
  @UseGuards(InternalNetworkGuard)
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
