import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { canonicalModelId, sameModelId } from '@/common/helpers/hub-pool';
import {
  type BackendHealthStatus,
  type BackendResidency,
  type HardwareProfile,
  INFERENCE_BACKEND_TYPES,
  type InferenceBackendType,
  type MemoryBudget,
  type ModelMemoryUsage,
  type ModelMemoryUsageEntry,
  type ResidentModel,
  type TrackedModel,
} from '@ci-hub/common/types';
import { InferenceBackendRegistry } from './backends/backend-registry';
import type { FootprintSighting } from './context-length.util';
import {
  readFootprintSightings,
  type RecordedSighting,
  sightingHardware,
  sightingMovedMaterially,
  writeFootprintSightings,
} from './footprint-sighting-record';
import { GpuProcessSamplerService, type GpuProcessVramSample } from './gpu-process-sampler.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelResidencyService } from './model-residency.service';

const SYSTEM_RESERVED_RAM_MB = 2048;
/** VRAM a discrete card keeps for the display and driver; the budget never lends it to a model. */
const DISPLAY_RESERVED_VRAM_MB = 512;
const DOCKER_OVERHEAD_PER_CONTAINER_MB = 500;
const MIB = 1024 * 1024;

/**
 * The most memory one model may occupy on this node with nothing else loaded, by the reserves
 * {@link MemoryManagerService.canFitModel} applies: the card less its display reserve on a discrete
 * GPU; on unified memory or CPU, live MemAvailable less the system reserve where the host samples
 * it, else the profile's figure as the context sizing always read it.
 *
 * The context window a load and a handout are sized at is chosen against this, not against the
 * whole card. Sized against `effectiveInferenceMemoryMb` (24,560 MB on beta-1's 7900 XTX) a 27B got
 * a 32768 window worth 24,371 MB, which the fit check — at 24,048 — then refused on an empty card.
 */
export function modelMemoryCeilingMb(profile: HardwareProfile): number {
  if (modelPoolFor(profile) === 'vram') {
    return Math.max(0, profile.gpu.vramMb - DISPLAY_RESERVED_VRAM_MB);
  }
  if (profile.ram.sampledAt) {
    return Math.max(0, profile.ram.availableMb - SYSTEM_RESERVED_RAM_MB);
  }
  return Math.max(0, profile.effectiveInferenceMemoryMb);
}

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
 * characters (`VLLM::EngineCor`, `dflash_server`). A row nothing here matches is not model memory
 * this budget knows about — except a bare `llama-server`, which {@link llamaServerOwner} settles.
 */
const ENGINE_PROCESS_PATTERNS: Partial<Record<InferenceBackendType, RegExp>> = {
  ollama: /ollama/,
  vllm: /vllm/,
  lemonade: /lemonade|lemond/,
  omlx: /omlx/,
};

/**
 * The one process name two engines share. Ollama's runner IS llama.cpp's server
 * (`/usr/local/lib/ollama/llama-server` — the path names it under nvidia-smi), and Lemonade spawns
 * the same binary from its own tree. Under rocm-smi both are the bare comm `llama-server`, so the
 * name alone cannot say whose it is.
 */
const LLAMA_SERVER_COMM = 'llama-server';
const LLAMA_SERVER_ENGINES = ['ollama', 'lemonade'] as const satisfies readonly InferenceBackendType[];

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
  /**
   * What each model was last measured occupying here, by {@link sightingKey}. Kept after the model
   * leaves memory, and across Hub restarts (see `footprint-sighting-record.ts`): the fit check that
   * needs it runs exactly when the model is NOT resident — it was evicted, it expired, the operator
   * unloaded it, the Hub restarted since — and a later sighting of the same model replaces it.
   */
  private readonly sightings = new Map<string, RecordedSighting>();
  /** The sightings file read once, on the first measurement, so what this process measures wins over it. */
  private sightingsRestored: Promise<void> | null = null;
  /** What the file holds, to write it only when a sighting moved (see {@link sightingMovedMaterially}). */
  private readonly persistedSightings = new Map<string, FootprintSighting>();
  /** Writes in the order they were asked for, so an older snapshot never lands over a newer one. */
  private sightingsWrite: Promise<void> = Promise.resolve();

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

    const modelBudgetVramMb = Math.max(0, totalVramMb - DISPLAY_RESERVED_VRAM_MB);
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
      // What the pin was measured holding, when it was: the registry's figure is the catalog's,
      // twice what gemma4:e4b holds on a 10 GB card, and it alone used up the budget for pins there.
      const usedMb = this.sightingOf(model.backend, model.backendModelId)?.footprintMb ?? model.memoryUsedMb;
      if (pool === 'ram') pinnedRamMb += usedMb;
      else pinnedVramMb += usedMb;
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

  /**
   * RAM a new model may take right now: the budget's arithmetic (total minus reserve, app
   * overhead and what the engines hold) capped by what the host actually has free.
   *
   * The budget's "used" is the engines' own figures, and on a unified-memory node the pool
   * they draw from is the whole machine: the apps, the OS, page cache under pressure, and any
   * engine the sweep could not size (`unmeasured` contributes 0 — a floor, by design) all take
   * from the same RAM, and none of them is in the arithmetic. That is how `ci` admitted a load
   * while vLLM held 96 GB of GTT out-of-band and Ollama got OOM-killed. `profile.ram.availableMb`
   * is MemAvailable read live by the hardware inspector on a Linux host (`ram.sampledAt` says
   * so): the kernel's own word on the remainder, so the cap follows the host, with the system
   * reserve off it the same as off the total. On macOS/Windows the figure is the desktop probe's
   * snapshot from app start — `vm_stat` free+inactive, routinely a fraction of RAM the OS would
   * hand over on demand — and it never recovers, so it must not cap anything.
   */
  private ramHeadroomMb(profile: HardwareProfile, budget: MemoryBudget): number {
    const budgeted = budget.modelBudgetRamMb - budget.modelUsedRamMb;
    if (!profile.ram.sampledAt) {
      return budgeted;
    }
    const live = Math.max(0, profile.ram.availableMb - SYSTEM_RESERVED_RAM_MB);
    return Math.min(budgeted, live);
  }

  /** Check if a model can fit in the current memory budget */
  async canFitModel(profile: HardwareProfile, memoryFootprintMb: number): Promise<{ fits: boolean; availableMb: number; requiredMb: number }> {
    const availableMb = await this.loadHeadroomMb(profile);
    return {
      fits: availableMb >= memoryFootprintMb,
      availableMb,
      requiredMb: memoryFootprintMb,
    };
  }

  /**
   * MB a new load may take right now — the figure {@link canFitModel} compares against. Separate so
   * the router can size a load's window to it (stepping the window down until the model fits)
   * before it asks whether anything must be evicted.
   */
  async loadHeadroomMb(profile: HardwareProfile): Promise<number> {
    const budget = await this.calculateBudget(profile);
    if (modelPoolFor(profile) === 'ram') {
      return this.ramHeadroomMb(profile, budget);
    }
    return budget.modelBudgetVramMb - budget.modelUsedVramMb;
  }

  /**
   * What `backendModelId` was last measured occupying on `backend` here, at what window, or null
   * when it has never been seen resident in a way that can be attributed to it (see
   * {@link attributeSightings}). Measures first, through the same cached observation the budget
   * uses, so a model resident right now is always answered for.
   */
  async footprintSighting(profile: HardwareProfile, backend: InferenceBackendType, backendModelId: string): Promise<FootprintSighting | null> {
    await this.observeUsage(profile);
    return this.sightingOf(backend, backendModelId);
  }

  /** Resolves once every sighting recorded so far has been written (or failed to be). */
  sightingsPersisted(): Promise<void> {
    return this.sightingsWrite;
  }

  private sightingOf(backend: InferenceBackendType, backendModelId: string): FootprintSighting | null {
    const recorded = this.sightings.get(sightingKey(backend, backendModelId));
    return recorded ? { footprintMb: recorded.footprintMb, contextLength: recorded.contextLength, source: recorded.source } : null;
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

  /**
   * What to unload so `requiredMb` more fits, or that nothing may be.
   *
   * Every candidate is a model an engine holds right now, sized in the units the budget itself
   * counted: the share of its engine's `usedMb` that is this model's (see
   * {@link residentSharesMb}). Sizing a candidate any other way plans in different units from the
   * figure it is meant to free. On beta-red the budget read gemma4:e4b's runner at 5,550 MB
   * (nvidia-smi) while `/api/ps` said 3,208, so the plan refused a load that evicting gemma4 would
   * have made room for; on beta-1 a Hub-tracked gemma4 was counted at its catalog 10,813 MB, evicted,
   * and the load refused anyway. A Hub-loaded model the engine no longer holds frees nothing, so it
   * is not a candidate at all.
   *
   * What a load may unload depends on who asked ({@link EvictionScope}), and a model with a
   * request running on it (a turn or an embedding batch) is never a candidate for anyone. Order:
   * the Hub's own loads least-recently-used first (the order it always evicted in), then, for an
   * operator, every other idle model the engines report, largest first so as few as possible go.
   * Pinned models and `keep` are never candidates, matched with Ollama's `name` ≡ `name:latest`
   * folding: `/api/ps` names the pinned embedder `nomic-embed-text:latest` while the catalog says
   * `nomic-embed-text`.
   *
   * A candidate nothing can size, or one sized at 0 (Ollama puts a model wholly on the CPU at
   * `size_vram` 0, which frees no VRAM), is never unloaded: it cannot be shown to help. When the
   * sized candidates cannot cover `requiredMb` the plan is empty — a refusal unloads nothing, where
   * it used to unload every candidate on the strength of one it could not size and then refuse.
   */
  async planEviction(
    profile: HardwareProfile,
    requiredMb: number,
    keep: { backend: InferenceBackendType; backendModelId: string },
    options: EvictionOptions,
  ): Promise<EvictionPlan> {
    const pool = modelPoolFor(profile);
    const observation = await this.observe(profile.gpu.vendor);
    const usage = deriveModelMemoryUsage({ pool, observation, tracked: this.modelRegistry.getLoadedModels() });
    const tracked = this.modelRegistry.getTrackedModels();
    const catalog = this.modelRegistry.getCatalog();
    const catalogRow = (backend: InferenceBackendType, backendModelId: string) =>
      catalog.find((model) => model.backend === backend && sameModelId(model.backendModelId, backendModelId));

    // What each resident model frees, per engine. `registry` rows are the engine NOT answering: there
    // is nothing live to unload through it, and nothing measured to size a candidate by.
    const residents = new Map<InferenceBackendType, Map<string, number | null>>();
    for (const entry of usage.backends) {
      if (entry.source === 'registry') continue;
      const reported = observation.residency.get(entry.backend)?.models ?? [];
      residents.set(
        entry.backend,
        residentSharesMb(entry, reported, pool, (id) => catalogRow(entry.backend, id)?.runtime.memoryFootprintMb ?? null),
      );
    }
    /** The engine's own spelling of `backendModelId` and what unloading it frees, or `undefined` when it is not resident. */
    const residentAs = (backend: InferenceBackendType, backendModelId: string): { id: string; sizeMb: number | null } | undefined => {
      for (const [id, sizeMb] of residents.get(backend) ?? []) {
        if (sameModelId(id, backendModelId)) return { id, sizeMb };
      }
      return undefined;
    };

    const busy: string[] = [];
    const isBusy = (candidate: EvictionCandidate): boolean => {
      const working = options.inUse?.(candidate.backend) ?? [];
      const inUse = working.some(
        (work) => sameModelId(work.model, candidate.backendModelId) || (candidate.catalogId !== null && work.model === candidate.catalogId),
      );
      if (inUse) busy.push(candidate.backendModelId);
      return inUse;
    };

    const ordered: EvictionCandidate[] = [];
    const seen = new Set<string>([evictionKey(keep.backend, keep.backendModelId)]);
    const add = (candidate: EvictionCandidate): void => {
      const key = evictionKey(candidate.backend, candidate.backendModelId);
      if (seen.has(key)) return;
      seen.add(key);
      if (isBusy(candidate)) return;
      ordered.push(candidate);
    };

    for (const model of this.modelRegistry.getEvictionCandidates()) {
      const resident = residentAs(model.backend, model.backendModelId);
      if (!resident) continue;
      add({ backend: model.backend, backendModelId: resident.id, catalogId: model.catalogId, estimatedMb: resident.sizeMb });
    }

    if (options.scope === 'operator') {
      const others: EvictionCandidate[] = [];
      for (const [backend, models] of residents) {
        for (const [backendModelId, estimatedMb] of models) {
          const own = tracked.find((model) => model.backend === backend && sameModelId(model.backendModelId, backendModelId));
          if (own?.pinned) continue;
          const catalogId = own?.catalogId ?? catalogRow(backend, backendModelId)?.id ?? null;
          others.push({ backend, backendModelId, catalogId, estimatedMb });
        }
      }
      others.sort((a, b) => (b.estimatedMb ?? 0) - (a.estimatedMb ?? 0));
      for (const candidate of others) add(candidate);
    }

    const candidates: EvictionCandidate[] = [];
    let freedMb = 0;
    for (const candidate of ordered) {
      if (freedMb >= requiredMb) break;
      if (candidate.estimatedMb === null || candidate.estimatedMb <= 0) continue;
      candidates.push(candidate);
      freedMb += candidate.estimatedMb;
    }

    if (freedMb < requiredMb) {
      return { canFree: false, candidates: [], freedMb, busy };
    }
    return { canFree: true, candidates, freedMb, busy };
  }

  /**
   * Drop the cached observation so the next budget is measured, not remembered. After an unload
   * the {@link LIVE_USAGE_TTL_MS} window would otherwise keep reporting the memory just freed.
   */
  invalidateObservation(): void {
    this.observation = null;
  }

  /** Check if an app can start given the current memory state */
  async canStartApp(profile: HardwareProfile, appMemoryMb: number): Promise<{ canStart: boolean; modelsToEvict: string[]; warning?: string }> {
    const budget = await this.calculateBudget(profile);
    const remainingRam = this.ramHeadroomMb(profile, budget);

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

  /**
   * Check if pinning a new model would exceed the budget. `model` names the one being pinned: when
   * it has been measured here, that figure stands in for the catalog's `memoryFootprintMb`, which
   * refused gemma4:e4b (10,813 MB) on the 10 GB card serving it in 5,550.
   */
  async canPinModel(
    profile: HardwareProfile,
    memoryFootprintMb: number,
    model?: { backend: InferenceBackendType; backendModelId: string },
  ): Promise<{ canPin: boolean; reason?: string }> {
    const budget = await this.calculateBudget(profile);
    const pinnedMb = (model ? this.sightingOf(model.backend, model.backendModelId)?.footprintMb : undefined) ?? memoryFootprintMb;

    if (modelPoolFor(profile) === 'ram') {
      const totalPinnedAfter = budget.pinnedRamMb + pinnedMb;
      if (totalPinnedAfter > budget.modelBudgetRamMb) {
        return { canPin: false, reason: `Pinning would use ${totalPinnedAfter} MB but only ${budget.modelBudgetRamMb} MB available for models` };
      }
    } else {
      const totalPinnedAfter = budget.pinnedVramMb + pinnedMb;
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
    const [observation] = await Promise.all([this.observe(profile.gpu.vendor), this.restoreSightings(profile)]);
    const pool = modelPoolFor(profile);
    const usage = deriveModelMemoryUsage({
      pool,
      observation,
      tracked: this.modelRegistry.getLoadedModels(),
    });
    let moved = false;
    for (const { backend, backendModelId, sighting } of attributeSightings(pool, observation, usage)) {
      const key = sightingKey(backend, backendModelId);
      this.sightings.set(key, { ...sighting, backend, model: backendModelId, seenAt: observation.sampledAt });
      moved ||= sightingMovedMaterially(this.persistedSightings.get(key), sighting);
    }
    if (moved) this.persistSightings(profile);
    return usage;
  }

  /**
   * Seeds the sightings from the file the last Hub process left, once, when it was measured on this
   * hardware. Anything this process has measured already stays: it is newer. A file that cannot be
   * read costs the restored figures, never the measurement.
   */
  private restoreSightings(profile: HardwareProfile): Promise<void> {
    this.sightingsRestored ??= readFootprintSightings()
      .then((record) => {
        if (!record || record.hardware !== sightingHardware(profile)) return;
        for (const entry of record.sightings) {
          const key = sightingKey(entry.backend, entry.model);
          this.persistedSightings.set(key, entry);
          if (!this.sightings.has(key)) this.sightings.set(key, entry);
        }
      })
      .catch((error) => {
        this._logger.debug(`Could not read the persisted model sightings: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.sightingsRestored;
  }

  /** Queues a write of every sighting held now. Never throws and never holds up the measurement that asked for it. */
  private persistSightings(profile: HardwareProfile): void {
    const snapshot = [...this.sightings.entries()];
    for (const [key, sighting] of snapshot) this.persistedSightings.set(key, sighting);
    const record = { hardware: sightingHardware(profile), sightings: snapshot.map(([, sighting]) => sighting) };
    this.sightingsWrite = this.sightingsWrite
      .then(() => writeFootprintSightings(record))
      .catch((error) => {
        this._logger.debug(`Could not persist the model sightings: ${error instanceof Error ? error.message : String(error)}`);
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

/** One model {@link MemoryManagerService.planEviction} would unload, whether or not the Hub loaded it. */
export type EvictionCandidate = {
  backend: InferenceBackendType;
  /** The engine's own spelling, as its residency listed it. */
  backendModelId: string;
  /** The catalog entry it corresponds to, when there is one; unloads then go through the registry. */
  catalogId: string | null;
  /** What unloading it frees, in the budget's own units; `null` when its engine's figure cannot be split to it. */
  estimatedMb: number | null;
};

/**
 * Who asked for a load, which decides what may be unloaded to make room for it.
 *
 * - `request`: an app's generation reaching the pool proxy or the router, or an agent's MCP call.
 *   Only models the Hub itself loaded may go, as before #1679. The app that loaded any other model
 *   is usually about to use it again: evicting Hermes' gemma4:e4b for an opencode turn on beta-1
 *   only made Hermes' next turn reload it cold.
 * - `operator`: a signed-in operator's pin or load. Any idle model any engine holds may go — that is
 *   how a pin clears the 27B an app loaded through Ollama directly before loading Lemonade's copy.
 */
export type EvictionScope = 'request' | 'operator';

export type EvictionOptions = {
  scope: EvictionScope;
  /**
   * What each engine has requests in flight for, generations and embedding batches alike
   * (`HubPoolLoadService.localBusyModelsOn`). Such a model is never a candidate, for either scope:
   * Ollama only marks a busy runner to expire and unloads it once its request ends, so the memory
   * does not come back in time for this load, and the app that was using it reloads it cold on its
   * next request. Only requests that pass through the pool proxy are seen.
   */
  inUse?: (backend: InferenceBackendType) => readonly { model: string }[];
};

export type EvictionPlan = {
  /** True only when the sized candidates free at least what was asked for. */
  canFree: boolean;
  /** What to unload, in order. Empty whenever `canFree` is false, so a refusal unloads nothing. */
  candidates: EvictionCandidate[];
  /** What `candidates` free; when `canFree` is false, everything this scope could have freed. */
  freedMb: number;
  /** Models left alone because a request is running on them, for the refusal's reason. */
  busy: string[];
};

/** Keyed under Ollama's `name` ≡ `name:latest` folding, so the kept model and a pin match however the engine spells them. */
function evictionKey(backend: InferenceBackendType, backendModelId: string): string {
  return `${backend}\u0000${canonicalModelId(backendModelId)}`;
}

/**
 * What unloading each of an engine's resident models frees, in the units the budget counted that
 * engine in, so a plan and the fit check it serves agree on what an eviction buys.
 *
 * With one model the engine's whole figure is that model's. With several, the figure is split in
 * the engine's own proportions (`size_vram` or `size` per model), else the catalog's footprints; a
 * model the engine reports at 0 bytes gets 0. When neither proportion exists — Lemonade sizes
 * nothing, and not every model it serves is in the catalog — or the engine is `unmeasured`, each
 * model is `null`: unsizable, so {@link MemoryManagerService.planEviction} will not unload it.
 */
function residentSharesMb(
  entry: ModelMemoryUsageEntry,
  reported: readonly ResidentModel[],
  pool: 'vram' | 'ram',
  footprintMb: (backendModelId: string) => number | null,
): Map<string, number | null> {
  const shares = new Map<string, number | null>();
  const usedMb = entry.usedMb;
  const [only] = entry.models;
  if (usedMb === null) {
    for (const id of entry.models) shares.set(id, null);
    return shares;
  }
  if (entry.models.length === 1 && only !== undefined) {
    shares.set(only, usedMb);
    return shares;
  }

  const engineWeights = entry.models.map((id) => {
    const model = reported.find((candidate) => candidate.id === id);
    return model ? (pool === 'vram' ? model.engineGpuBytes : model.totalBytes) : null;
  });
  const catalogWeights = entry.models.map((id) => footprintMb(id));
  const weights = [engineWeights, catalogWeights].find((set): set is number[] => set.every((w) => w !== null) && sum(set as number[]) > 0);
  const total = weights ? sum(weights) : 0;
  entry.models.forEach((id, index) => {
    shares.set(id, weights ? Math.round((usedMb * (weights[index] ?? 0)) / total) : null);
  });
  return shares;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** One spelling per model, so `nomic-embed-text` and the `nomic-embed-text:latest` `/api/ps` names share a sighting. */
function sightingKey(backend: InferenceBackendType, backendModelId: string): string {
  return `${backend}\u0000${canonicalModelId(backendModelId)}`;
}

/**
 * What each resident model can be said to occupy, in the budget's own units, with the window it was
 * loaded at: the {@link FootprintSighting}s the context sizing prefers to the catalog.
 *
 * Only what the observation can attribute to one model counts. The engine's row must be a
 * measurement (`process` or `engine`, not the registry's bookkeeping), and the model must report
 * its window. A process figure shared by several models is split in the proportions the engine
 * itself reports for them. On a discrete card the model must also have been wholly on the GPU
 * (`size_vram` equal to `size`): beta-3-glass held a 27B at a 16384 window in 6,104 MiB of an
 * 8 GB card on 2026-09-29 only because Ollama had put three quarters of it in system RAM, and that
 * figure says nothing about what the card must hold to serve the model there.
 */
function attributeSightings(
  pool: 'vram' | 'ram',
  observation: LiveObservation,
  usage: ModelMemoryUsage,
): { backend: InferenceBackendType; backendModelId: string; sighting: FootprintSighting }[] {
  const out: { backend: InferenceBackendType; backendModelId: string; sighting: FootprintSighting }[] = [];
  for (const entry of usage.backends) {
    if ((entry.source !== 'process' && entry.source !== 'engine') || entry.usedMb === null) continue;
    const models = (observation.residency.get(entry.backend)?.models ?? []).filter((model) => entry.models.includes(model.id));
    if (models.length === 0) continue;
    const bytesOf = (model: (typeof models)[number]) => (pool === 'vram' ? model.engineGpuBytes : model.totalBytes);
    const knownBytes = models.map(bytesOf);
    const totalBytes = knownBytes.every((bytes) => bytes !== null) ? knownBytes.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0) : null;
    for (const model of models) {
      if (model.contextLength === null || model.contextLength <= 0) continue;
      if (pool === 'vram' && !(model.engineGpuBytes !== null && model.totalBytes !== null && model.engineGpuBytes >= model.totalBytes)) continue;
      const bytes = bytesOf(model);
      let footprintMb: number | null = null;
      if (entry.source === 'engine') {
        footprintMb = bytes === null ? null : bytes / MIB;
      } else if (models.length === 1) {
        footprintMb = entry.usedMb;
      } else if (bytes !== null && totalBytes !== null && totalBytes > 0) {
        footprintMb = (entry.usedMb * bytes) / totalBytes;
      }
      if (footprintMb === null || !(footprintMb > 0)) continue;
      out.push({
        backend: entry.backend,
        backendModelId: model.id,
        sighting: { footprintMb: Math.round(footprintMb), contextLength: model.contextLength, source: entry.source },
      });
    }
  }
  return out;
}

/** Where models live on this node. Mirrors the branch the budget has always taken. */
export function modelPoolFor(profile: HardwareProfile): 'vram' | 'ram' {
  return profile.gpu.unifiedMemory || !profile.gpu.available ? 'ram' : 'vram';
}

/**
 * Turns one observation into per-engine rows. The precedence, per engine: its process as the
 * vendor tool sees it, else its own accounting when it gives sizes, else — only when the engine
 * could not be asked at all — the Hub's own bookkeeping of what it loaded there. An engine that
 * is holding something none of those can size is reported as `unmeasured`, never as 0.
 *
 * The process reading goes first because it is the only one of the three that is a measurement.
 * Ollama's `/api/ps` `size_vram` is the scheduler's plan for the weights and KV cache; measured on
 * beta-red it said 1,533 MiB for gemma4:e4b while nvidia-smi held 2,926 MiB for the same runner —
 * the CUDA context and compute buffers are real VRAM the plan does not count, and it is the
 * measured figure that decides whether the next model fits.
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
    // rest would report a floor as if it were the whole — so the engine's own figure is only a
    // fallback when every model carries one.
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

  const bareLlamaServerOwner = llamaServerOwner(
    LLAMA_SERVER_ENGINES.filter((type) => {
      const resident = residentByBackend.get(type);
      return resident !== undefined && resident !== 'none' && resident !== 'unknown';
    }),
  );

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

    const processMb = sumProcessVramMb(type, observation.samples, bareLlamaServerOwner);
    if (processMb > 0) {
      backends.push({ backend: type, models: resident.models, pool, usedMb: processMb, source: 'process' });
      continue;
    }

    if (resident.engineMb !== null) {
      backends.push({ backend: type, models: resident.models, pool, usedMb: resident.engineMb, source: 'engine' });
      continue;
    }

    backends.push({ backend: type, models: resident.models, pool, usedMb: null, source: 'unmeasured' });
  }

  return { sampledAt: observation.sampledAt, backends };
}

/**
 * Who a bare `llama-server` row belongs to: whichever of the two llama.cpp-hosting engines is
 * the only one holding a model right now. With both holding something the row stays unclaimed —
 * Ollama then falls back to its own `/api/ps` figure and Lemonade reads as unmeasured, which is
 * a floor rather than the double count that claiming it for both would be.
 */
function llamaServerOwner(holding: readonly InferenceBackendType[]): InferenceBackendType | null {
  return holding.length === 1 ? (holding[0] ?? null) : null;
}

function sumProcessVramMb(type: InferenceBackendType, samples: GpuProcessVramSample[], bareLlamaServerOwner: InferenceBackendType | null): number {
  const pattern = ENGINE_PROCESS_PATTERNS[type];
  if (!pattern) return 0;
  return samples
    .filter((sample) => {
      const name = sample.processName.toLowerCase();
      return pattern.test(name) || (name === LLAMA_SERVER_COMM && bareLlamaServerOwner === type);
    })
    .reduce((sum, sample) => sum + sample.vramMb, 0);
}
