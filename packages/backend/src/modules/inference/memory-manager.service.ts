import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import {
  type BackendHealthStatus,
  type BackendResidency,
  type HardwareProfile,
  INFERENCE_BACKEND_TYPES,
  type InferenceBackendType,
  type MemoryBudget,
  type ModelMemoryUsage,
  type ModelMemoryUsageEntry,
  type TrackedModel,
} from '@ci-hub/common/types';
import { InferenceBackendRegistry } from './backends/backend-registry';
import { GpuProcessSamplerService, type GpuProcessVramSample } from './gpu-process-sampler.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelResidencyService } from './model-residency.service';

const SYSTEM_RESERVED_RAM_MB = 2048;
const DOCKER_OVERHEAD_PER_CONTAINER_MB = 500;

/**
 * How long one live observation of the engines stands in for the next. The router asks for a
 * budget on every request it has to place, and the dashboard asks for `/inference/status` and
 * `/inference/memory` in the same tick; without this each of those would be its own `/api/ps`
 * plus a vendor-tool shell-out. Short, because residency is the one figure here that moves
 * minute to minute as models load and expire.
 */
const LIVE_USAGE_TTL_MS = 5_000;

/**
 * Which vendor-tool process rows belong to which engine, matched against the row's process name
 * lowercased. `nvidia-smi` reports a full path or the process title (`VLLM::EngineCore`,
 * `/usr/local/lib/ollama/llama-server`); `rocm-smi` reports the kernel `comm`, truncated to 15
 * characters (`VLLM::EngineCor`, `dflash_server`). Ollama is deliberately absent: its figure comes
 * from `/api/ps`, and its runner is a bare `llama-server` under rocm-smi — indistinguishable from
 * the one Lemonade spawns, so neither name is claimed for Lemonade either. A row nothing here
 * matches is not model memory this budget knows about.
 */
const ENGINE_PROCESS_PATTERNS: Partial<Record<InferenceBackendType, RegExp>> = {
  vllm: /vllm/,
  lucebox: /dflash|lucebox/,
  lemonade: /lemonade|lemond/,
  mtplx: /mtplx/,
  dspark: /dspark/,
};

/** One sweep over everything that can say what is in memory, taken together so the figures agree in time. */
type LiveObservation = {
  sampledAt: string;
  residency: Map<InferenceBackendType, BackendResidency>;
  /** Only for engines without `listResident`: they serve exactly what they were started with, so inventory is residency. */
  health: Map<InferenceBackendType, BackendHealthStatus>;
  samples: GpuProcessVramSample[];
};

@Injectable()
export class MemoryManagerService {
  private runningAppContainerCount = 0;
  private observation: { at: number; vendor: string; value: LiveObservation } | null = null;
  private observationInFlight: { vendor: string; promise: Promise<LiveObservation> } | null = null;

  constructor(
    readonly _logger: LoggerService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly backends: InferenceBackendRegistry,
    private readonly residency: ModelResidencyService,
    private readonly gpuSampler: GpuProcessSamplerService,
  ) {}

  /** Set the number of running app containers (updated by app lifecycle) */
  setRunningAppCount(count: number): void {
    this.runningAppContainerCount = count;
  }

  /**
   * Calculate the current memory budget.
   *
   * "Used" is what the engines hold NOW, read live, not what this Hub's router loaded. The two
   * differ on every node in the fleet: pool traffic through the proxy, apps calling Ollama
   * directly, and out-of-band vLLM/Lemonade/Lucebox servers all load models the registry never
   * hears about, and a budget built from the registry alone read 0 on every one of them while
   * the router's "available" arithmetic over-admitted by the whole card. Pinned stays the
   * registry's: only the router pins, so only it knows.
   */
  async calculateBudget(profile: HardwareProfile): Promise<MemoryBudget> {
    const totalVramMb = profile.gpu.unifiedMemory ? 0 : profile.gpu.available ? profile.gpu.vramMb : 0;
    const totalRamMb = profile.ram.totalMb;

    const dockerOverheadMb = this.runningAppContainerCount * DOCKER_OVERHEAD_PER_CONTAINER_MB;
    const appContainerBudgetMb = dockerOverheadMb;

    const modelBudgetVramMb = Math.max(0, totalVramMb - 512); // Reserve 512 MB VRAM for display
    const modelBudgetRamMb = Math.max(0, totalRamMb - SYSTEM_RESERVED_RAM_MB - appContainerBudgetMb);

    const pool = modelPoolFor(profile);
    const usage = await this.observeUsage(profile);

    let modelUsedVramMb = 0;
    let modelUsedRamMb = 0;
    for (const entry of usage.backends) {
      if (entry.usedMb === null) continue;
      if (entry.pool === 'ram') modelUsedRamMb += entry.usedMb;
      else modelUsedVramMb += entry.usedMb;
    }

    let pinnedVramMb = 0;
    let pinnedRamMb = 0;
    for (const model of this.modelRegistry.getLoadedModels()) {
      if (!model.pinned) continue;
      if (pool === 'ram') pinnedRamMb += model.memoryUsedMb;
      else pinnedVramMb += model.memoryUsedMb;
    }

    return {
      totalVramMb,
      totalRamMb,
      systemReservedRamMb: SYSTEM_RESERVED_RAM_MB,
      dockerOverheadMb,
      appContainerBudgetMb,
      modelBudgetVramMb,
      modelBudgetRamMb,
      modelUsedVramMb,
      modelUsedRamMb,
      pinnedVramMb,
      pinnedRamMb,
      usage,
    };
  }

  /** Check if a model can fit in the current memory budget */
  async canFitModel(profile: HardwareProfile, memoryFootprintMb: number): Promise<{ fits: boolean; availableMb: number; requiredMb: number }> {
    const budget = await this.calculateBudget(profile);

    let availableMb: number;
    if (modelPoolFor(profile) === 'ram') {
      availableMb = budget.modelBudgetRamMb - budget.modelUsedRamMb;
    } else {
      availableMb = budget.modelBudgetVramMb - budget.modelUsedVramMb;
    }

    return {
      fits: availableMb >= memoryFootprintMb,
      availableMb,
      requiredMb: memoryFootprintMb,
    };
  }

  /** Determine which models to evict to free the required memory */
  getModelsToEvict(_profile: HardwareProfile, requiredMb: number): { canFree: boolean; modelsToEvict: string[]; freedMb: number } {
    const candidates = this.modelRegistry.getEvictionCandidates();
    const modelsToEvict: string[] = [];
    let freedMb = 0;

    for (const candidate of candidates) {
      if (freedMb >= requiredMb) break;
      modelsToEvict.push(candidate.catalogId);
      freedMb += candidate.memoryUsedMb;
    }

    return {
      canFree: freedMb >= requiredMb,
      modelsToEvict,
      freedMb,
    };
  }

  /** Check if an app can start given the current memory state */
  async canStartApp(profile: HardwareProfile, appMemoryMb: number): Promise<{ canStart: boolean; modelsToEvict: string[]; warning?: string }> {
    const budget = await this.calculateBudget(profile);
    const remainingRam = budget.modelBudgetRamMb - budget.modelUsedRamMb;

    if (remainingRam >= appMemoryMb) {
      return { canStart: true, modelsToEvict: [] };
    }

    // Need to evict unpinned models
    const deficit = appMemoryMb - remainingRam;
    const eviction = this.getModelsToEvict(profile, deficit);

    if (eviction.canFree) {
      return {
        canStart: true,
        modelsToEvict: eviction.modelsToEvict,
        warning: `Starting this app will evict ${eviction.modelsToEvict.length} model(s) from memory`,
      };
    }

    // Would need to evict pinned models — deny
    return {
      canStart: false,
      modelsToEvict: [],
      warning: `Insufficient memory. ${appMemoryMb} MB required but only ${remainingRam + eviction.freedMb} MB available (pinned models cannot be evicted)`,
    };
  }

  /** Check if pinning a new model would exceed the budget */
  async canPinModel(profile: HardwareProfile, memoryFootprintMb: number): Promise<{ canPin: boolean; reason?: string }> {
    const budget = await this.calculateBudget(profile);

    if (modelPoolFor(profile) === 'ram') {
      const totalPinnedAfter = budget.pinnedRamMb + memoryFootprintMb;
      if (totalPinnedAfter > budget.modelBudgetRamMb) {
        return { canPin: false, reason: `Pinning would use ${totalPinnedAfter} MB but only ${budget.modelBudgetRamMb} MB available for models` };
      }
    } else {
      const totalPinnedAfter = budget.pinnedVramMb + memoryFootprintMb;
      if (totalPinnedAfter > budget.modelBudgetVramMb) {
        return { canPin: false, reason: `Pinning would use ${totalPinnedAfter} MB VRAM but only ${budget.modelBudgetVramMb} MB available` };
      }
    }

    return { canPin: true };
  }

  /**
   * What every engine holds right now, as {@link ModelMemoryUsageEntry} rows. Never throws: a
   * budget that cannot be read is a budget that reads as empty, which is exactly the failure this
   * exists to remove, so each source degrades on its own (see {@link observe}).
   */
  private async observeUsage(profile: HardwareProfile): Promise<ModelMemoryUsage> {
    const observation = await this.observe(profile.gpu.vendor);
    return deriveModelMemoryUsage({
      pool: modelPoolFor(profile),
      observation,
      tracked: this.modelRegistry.getLoadedModels(),
    });
  }

  /**
   * One sweep, shared by every caller inside {@link LIVE_USAGE_TTL_MS} and single-flighted while
   * it runs. Keyed by GPU vendor because that is the only input the sweep itself depends on;
   * the pool a figure lands in is decided afterwards from the profile handed to each call.
   */
  private observe(vendor: string): Promise<LiveObservation> {
    const now = Date.now();
    if (this.observation && this.observation.vendor === vendor && now - this.observation.at < LIVE_USAGE_TTL_MS) {
      return Promise.resolve(this.observation.value);
    }
    if (this.observationInFlight && this.observationInFlight.vendor === vendor) {
      return this.observationInFlight.promise;
    }
    const promise = this.sweep(vendor)
      .then((value) => {
        this.observation = { at: Date.now(), vendor, value };
        return value;
      })
      .finally(() => {
        if (this.observationInFlight?.promise === promise) this.observationInFlight = null;
      });
    this.observationInFlight = { vendor, promise };
    return promise;
  }

  private async sweep(vendor: string): Promise<LiveObservation> {
    const sampledAt = new Date().toISOString();
    const [report, health, samples] = await Promise.all([
      this.residency.getReport(sampledAt),
      Promise.all(
        this.backends
          .entries()
          .filter(([, backend]) => typeof backend.listResident !== 'function')
          .map(
            async ([type, backend]) =>
              [type, await backend.healthCheck().catch(() => ({ running: false, healthy: false, modelsLoaded: [] as string[] }))] as const,
          ),
      ),
      // The sampler already never throws, but a throw here must still cost only the GPU figure.
      this.gpuSampler.sampleVramByProcess(vendor).catch((error) => {
        this._logger.debug(`Per-process GPU sample failed: ${error instanceof Error ? error.message : String(error)}`);
        return [] as GpuProcessVramSample[];
      }),
    ]);

    return {
      sampledAt,
      residency: new Map(report.backends.map((entry) => [entry.backend, entry])),
      health: new Map(health),
      samples,
    };
  }
}

/** Where models live on this node. Mirrors the branch the budget has always taken. */
function modelPoolFor(profile: HardwareProfile): 'vram' | 'ram' {
  return profile.gpu.unifiedMemory || !profile.gpu.available ? 'ram' : 'vram';
}

/**
 * Turns one observation into per-engine rows. The precedence, per engine: its own accounting
 * when it gives sizes, else its process as the vendor tool sees it, else — only when the engine
 * could not be asked at all — the Hub's own bookkeeping of what it loaded there. An engine that
 * is holding something none of those can size is reported as `unmeasured`, never as 0.
 */
function deriveModelMemoryUsage(input: { pool: 'vram' | 'ram'; observation: LiveObservation; tracked: TrackedModel[] }): ModelMemoryUsage {
  const { pool, observation, tracked } = input;
  const backends: ModelMemoryUsageEntry[] = [];

  const residentByBackend = new Map<InferenceBackendType, { models: string[]; engineMb: number | null } | 'unknown' | 'none'>();
  for (const [type, residency] of observation.residency) {
    // `unsupported` is "this engine has no residency concept", not "it could not be asked": its
    // inventory IS its residency, and that arrives through the health sweep below.
    if (residency.source === 'unsupported') continue;
    if (residency.models === null) {
      residentByBackend.set(type, 'unknown');
      continue;
    }
    if (residency.models.length === 0) {
      residentByBackend.set(type, 'none');
      continue;
    }
    // Ollama sizes both pools per model (`size_vram`, `size`); Lemonade names its models and
    // sizes neither. One model without a figure makes the engine's total unusable — summing the
    // rest would report a floor as if it were the whole — so the engine falls through to the
    // process reading below.
    let engineMb: number | null = 0;
    for (const model of residency.models) {
      const bytes = pool === 'vram' ? model.engineGpuBytes : model.totalBytes;
      if (bytes === null) {
        engineMb = null;
        break;
      }
      engineMb += bytes / (1024 * 1024);
    }
    residentByBackend.set(type, { models: residency.models.map((model) => model.id), engineMb: engineMb === null ? null : Math.round(engineMb) });
  }
  for (const [type, health] of observation.health) {
    if (residentByBackend.has(type)) continue;
    if (!health.healthy) {
      residentByBackend.set(type, 'unknown');
      continue;
    }
    residentByBackend.set(type, health.modelsLoaded.length > 0 ? { models: [...health.modelsLoaded], engineMb: null } : 'none');
  }

  for (const type of INFERENCE_BACKEND_TYPES) {
    const resident = residentByBackend.get(type);
    if (resident === undefined || resident === 'none') continue;

    if (resident === 'unknown') {
      const bookkept = tracked.filter((model) => model.backend === type);
      if (bookkept.length === 0) continue;
      backends.push({
        backend: type,
        models: bookkept.map((model) => model.backendModelId),
        pool,
        usedMb: bookkept.reduce((sum, model) => sum + model.memoryUsedMb, 0),
        source: 'registry',
      });
      continue;
    }

    if (resident.engineMb !== null) {
      backends.push({ backend: type, models: resident.models, pool, usedMb: resident.engineMb, source: 'engine' });
      continue;
    }

    const processMb = sumProcessVramMb(type, observation.samples);
    if (processMb > 0) {
      backends.push({ backend: type, models: resident.models, pool, usedMb: processMb, source: 'process' });
      continue;
    }

    backends.push({ backend: type, models: resident.models, pool, usedMb: null, source: 'unmeasured' });
  }

  return { sampledAt: observation.sampledAt, backends };
}

function sumProcessVramMb(type: InferenceBackendType, samples: GpuProcessVramSample[]): number {
  const pattern = ENGINE_PROCESS_PATTERNS[type];
  if (!pattern) return 0;
  return samples.filter((sample) => pattern.test(sample.processName.toLowerCase())).reduce((sum, sample) => sum + sample.vramMb, 0);
}
