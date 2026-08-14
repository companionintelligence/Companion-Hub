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
} from './inference.dto';
import { OllamaBackend } from './backends/ollama.backend';
import { resolveVllmProbeUrl, VLLM_PROBE_API_KEY_HEADER, VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { resolveInstalledCatalogIds, resolveInstalledCatalogIdsFromServedModels } from './model-availability.util';

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
    private readonly moduleRef: ModuleRef,
    readonly _logger: LoggerService,
  ) {}

  private getRecommendedBackend(profile: HardwareProfile): InferenceBackendType {
    // AMD GPUs (including the Strix Halo APU) always recommend Ollama, whether or not ROCm is
    // ready: its official image covers both cases — the `:rocm` tag when /dev/kfd passthrough
    // works, and the default tag (which bundles a Vulkan/RADV ggml backend that auto-activates via
    // /dev/dri) as the fallback — see OllamaBackend.getDockerImage()/.getComposeConfig(). vLLM has
    // no reliably maintained ROCm image for this hardware — see VllmBackend.getComposeConfig(),
    // which declines AMD outright rather than mount devices into an image that can't use them.
    return profile.npu.available ? 'lemonade' : profile.gpu.vendor === 'nvidia' && profile.gpu.runtimeAvailable ? 'vllm' : 'ollama';
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
    );

    this.appCredentials.invalidateCache();

    // Restart running apps that use AI models so they pick up the new inference
    // preferences. AppLifecycleService is resolved lazily via ModuleRef (rather
    // than imported into InferenceModule) to avoid a circular module dependency,
    // and the restart is fire-and-forget so the response isn't blocked on it.
    try {
      const { AppLifecycleService } = await import('../app-lifecycle/app-lifecycle.service');
      const appLifecycle = this.moduleRef.get(AppLifecycleService, { strict: false });
      if (appLifecycle) {
        void appLifecycle.restartAiApps();
      }
    } catch (e) {
      this._logger.error('Failed to trigger AI app restarts after preferences update', e);
    }

    return result;
  }

  @UseGuards(AuthGuard)
  @Get('models/runtime')
  async getRuntimeModels(@Query() query: RuntimeModelsQueryDto) {
    const backend = query.backend;
    const backendService = backend === 'ollama' ? this.ollamaBackend : backend === 'vllm' ? this.vllmBackend : this.lemonadeBackend;

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
    if (installBackend === 'vllm') {
      const vllmHealth = await this.vllmBackend.healthCheck(query?.vllmUrl, vllmApiKey).catch(() => ({
        running: false,
        healthy: false,
        modelsLoaded: [] as string[],
      }));
      const vllmInstalled = resolveInstalledCatalogIdsFromServedModels(catalog, vllmHealth.modelsLoaded ?? [], 'vllm', getTrackedState);
      const ollamaEmbeddingIds = ollamaInstalled.filter((id) => {
        const model = catalog.find((m) => m.id === id);
        return model?.modality === 'embedding';
      });
      installedCatalogIds = [...new Set([...vllmInstalled, ...ollamaEmbeddingIds])];
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
    return {
      ready,
      running: health.running,
      endpointUrl: probeUrl,
      displayEndpoint,
      // The suggested model must be a catalog `backendModelId` (so the served model is recognized
      // as installed) and must fit common consumer VRAM — Qwen3-4B-Instruct-2507 with bitsandbytes
      // quantization runs on an 8 GB card, unlike the old Qwen2.5-7B bf16 suggestion (#1103).
      remediationCommand: ready
        ? undefined
        : 'vllm serve Qwen/Qwen3-4B-Instruct-2507 --host 0.0.0.0 --port 8000 --quantization bitsandbytes --max-model-len 8192 --gpu-memory-utilization 0.85',
      error: ready ? undefined : health.error,
      hint: ready
        ? undefined
        : `Run vLLM on the host (not inside Docker). Hub probes from inside its container — use http://host.docker.internal:8000, not localhost. Currently probing ${probeUrl}.`,
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
