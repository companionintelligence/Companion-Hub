import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type {
  CuratedModel,
  HardwareProfile,
  HardwareTier,
  HostPlatform,
  InferenceBackendType,
  ModelModality,
  ModelState,
  TrackedModel,
} from '@ci-hub/common/types';
import { CURATED_MODELS } from './catalog/curated-models';

// ─── Hardware-fit selection tuning ──────────────────────────────────────────
// The curated catalog (CURATED_MODELS) is the single source of truth for model sizing.
// Hardware recommendations are *computed* by fitting each model's real memory footprint into a
// budget derived from the hardware profile — not picked from a hand-maintained model-ID table,
// which drifts from the generated catalog and mis-sizes consumer/workstation hardware.

type GpuVendorKey = CuratedModel['requirements']['gpuVendors'][number]; // 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu'

// Vendors Ollama can actually offload to. Anything else (e.g. Intel) falls back to CPU inference.
const GPU_INFERENCE_VENDORS = new Set<HardwareProfile['gpu']['vendor']>(['nvidia', 'amd', 'apple']);

const HOST_SERVED_BACKENDS = new Set<InferenceBackendType>(['vllm', 'mtplx', 'dspark', 'lucebox']);

// Fraction of each memory pool a model may occupy, leaving headroom for the OS, the app container,
// KV-cache/context growth, and (for shared pools) everything else running on the machine.
const VRAM_BUDGET_FRACTION = 0.9; // dedicated discrete-GPU VRAM
const UNIFIED_MEMORY_BUDGET_FRACTION = 0.7; // Apple Silicon: GPU shares system RAM with the OS/apps
const SYSTEM_RAM_BUDGET_FRACTION = 0.7; // CPU-only inference, out of system RAM

// CPU inference of large models is impractically slow, so cap CPU-only picks to small/fast models.
const CPU_ONLY_MAX_PARAMETER_SCALE = 14; // billions of parameters

// How many distinct LLMs to surface as "recommended" (best first). App bootstrap installs index 0.
const MAX_RECOMMENDED_LLMS = 5;

// Quant preference between equal-size models: q8 is effectively lossless, fp16 is wasteful for no
// real gain, sub-q4 (q3) is a last resort. Higher = preferred.
const QUANT_QUALITY_RANK: Record<string, number> = { q8_0: 6, q6_K: 5, q5_K_M: 4, q4_K_M: 3, fp16: 2, q3_K_M: 1 };
const SUB_Q4_QUANTS = new Set(['q3_K_M']);
const QUANT_SUFFIX_RE = /-(fp16|q8_0|q6_K|q5_K_M|q4_K_M|q3_K_M)$/;

// Size classes (billions of params) so the recommended list can span small/medium/large instead of
// clustering at the top end — the installer should surface a useful range the hardware can run.
type ModelSizeClass = 'small' | 'medium' | 'large';
const SIZE_CLASS_SMALL_MAX_PARAMS = 14; // ≤14B = small
const SIZE_CLASS_MEDIUM_MAX_PARAMS = 70; // 15–70B = medium; >70B = large
const SIZE_CLASS_ORDER: ModelSizeClass[] = ['large', 'medium', 'small'];

function sizeClassOf(model: CuratedModel): ModelSizeClass {
  const params = model.parameterScale ?? 0;
  if (params <= SIZE_CLASS_SMALL_MAX_PARAMS) return 'small';
  if (params <= SIZE_CLASS_MEDIUM_MAX_PARAMS) return 'medium';
  return 'large';
}

// On a memory-bandwidth-constrained shared-memory GPU — an x86 APU (AMD/Intel) whose
// "VRAM" is ordinary system RAM — the per-token bottleneck is bandwidth ∝ ACTIVE
// params, not capacity. A large dense model "fits" the big shared budget but must
// stream all its weights every token, so it is bandwidth-bound (measured: a dense 27B
// managed ~11 tok/s on a Radeon 8060S APU while a 3B-active MoE managed ~70). Cap the
// active size so selection there prefers MoE / smaller-dense models. NOT applied to
// Apple Silicon: its unified memory is high-bandwidth and runs large dense models well.
// Heuristic — tune as more hardware data lands.
const APU_MAX_ACTIVE_PARAMS_B = 14;

/** Active (per-token) parameter count in billions; dense models fall back to total params. */
function activeParamsOf(model: CuratedModel): number {
  return model.activeParameterScale ?? model.parameterScale ?? Number.POSITIVE_INFINITY;
}

/**
 * A `:cloud`-tagged catalog row (e.g. `glm-5.2:cloud`) proxies inference through Ollama Cloud rather
 * than running on the user's own hardware. Its catalog `gb`/footprint is a nominal placeholder, not a
 * real local memory cost, so it must never compete for "best local model that fits this hardware" —
 * that comparison is only meaningful between models that actually run on the box being sized. Per
 * product decision, this tool exists to find the best model a user's own hardware can run, so a
 * cloud-proxied model must never even be *shown* — not just excluded from the recommendation — which is
 * why `getModelsForTier()` (the tier gate every browsing path filters through, before the optional
 * host-platform gate below) excludes it too.
 */
function isCloudProxyModel(model: CuratedModel): boolean {
  return model.backendModelId.endsWith(':cloud');
}

function isHostPlatform(platform: string | undefined): platform is HostPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

/**
 * Order LLM candidates best-first. The primary key is the Artificial Analysis Intelligence Index
 * (higher = smarter) so the best-fit default is the most capable model that fits the hardware — not
 * merely the largest. Models without a measured index score 0 (we can't claim intelligence we haven't
 * measured), so a scored model is preferred over an unscored one of any size. Remaining ties fall back
 * to the prior heuristics: q4+ before sub-q4, then bigger parameter count, then higher-fidelity quant.
 */
export function compareLlmCandidates(a: CuratedModel, b: CuratedModel): number {
  const intel = (b.metadata?.intelligenceIndex ?? 0) - (a.metadata?.intelligenceIndex ?? 0);
  if (intel !== 0) return intel;
  const aSubQ4 = SUB_Q4_QUANTS.has(a.runtime.quantization ?? '') ? 1 : 0;
  const bSubQ4 = SUB_Q4_QUANTS.has(b.runtime.quantization ?? '') ? 1 : 0;
  if (aSubQ4 !== bSubQ4) return aSubQ4 - bSubQ4;
  const params = (b.parameterScale ?? 0) - (a.parameterScale ?? 0);
  if (params !== 0) return params;
  return (QUANT_QUALITY_RANK[b.runtime.quantization ?? ''] ?? 0) - (QUANT_QUALITY_RANK[a.runtime.quantization ?? ''] ?? 0);
}

/** Usable memory budget for inference, derived from the hardware profile. */
interface InferenceBudget {
  /** Memory a model may occupy (MB): discrete VRAM, usable unified RAM, or usable system RAM. */
  budgetMb: number;
  /** True when inference runs on the CPU out of system RAM (no GPU Ollama can offload to). */
  cpuOnly: boolean;
  /** GPU vendor key for catalog requirement matching ('cpu' when there is no usable GPU). */
  vendor: GpuVendorKey;
  /**
   * True on a memory-bandwidth-constrained shared-memory GPU — an x86 APU whose "VRAM"
   * is system RAM. There per-token speed is bound by active params, so selection caps
   * active size to prefer MoE / smaller-dense models. False for discrete VRAM, CPU, and
   * Apple Silicon (whose unified memory is high-bandwidth and runs dense models well).
   */
  bandwidthConstrained: boolean;
}

@Injectable()
export class ModelRegistryService implements OnModuleInit {
  /** Tracked model states (in-memory only; does not survive process restarts) */
  private readonly trackedModels = new Map<string, TrackedModel>();

  constructor(private readonly logger: LoggerService) {}

  onModuleInit() {
    this.logger.info(`[ModelRegistry] Loaded ${CURATED_MODELS.length} curated models`);
  }

  /** Get the curated catalog */
  getCatalog(): CuratedModel[] {
    return CURATED_MODELS;
  }

  /** Filter catalog by hardware tier. Platform-specific filtering is applied by getModelsForHardware. */
  getModelsForTier(tier: HardwareTier): CuratedModel[] {
    const tierKey = tier === 'cpu-only' ? 'cpuOnly' : tier;
    if (tier === 'insufficient') return [];
    return CURATED_MODELS.filter((m) => {
      if (isCloudProxyModel(m)) return false;
      const rec = m.tiers[tierKey as keyof typeof m.tiers];
      return rec === 'recommended' || rec === 'available';
    });
  }

  /**
   * Filter the tier catalog against the detected host platform. A missing or unknown platform is
   * treated as legacy/unknown data and keeps the historical tier-only behavior. Host-served rows
   * can optionally remain visible because their endpoint may be on another machine; they are never
   * included in automatic local recommendations unless the platform matches.
   */
  getModelsForHardware(tier: HardwareTier, profile: HardwareProfile, options?: { includeRemoteHostBackends?: boolean }): CuratedModel[] {
    const models = this.getModelsForTier(tier);
    const platform = profile.os?.platform;
    if (!isHostPlatform(platform)) return models;

    return models.filter(
      (model) =>
        model.requirements.supportedPlatforms?.includes(platform) !== false ||
        (options?.includeRemoteHostBackends === true && HOST_SERVED_BACKENDS.has(model.backend)),
    );
  }

  /** Get recommended models for a tier (default pulls) */
  getRecommendedModels(tier: HardwareTier, profile?: HardwareProfile): CuratedModel[] {
    const tierKey = tier === 'cpu-only' ? 'cpuOnly' : tier;
    if (tier === 'insufficient') return [];
    const models = profile ? this.getModelsForHardware(tier, profile) : this.getModelsForTier(tier);
    return models.filter((m) => m.tiers[tierKey as keyof typeof m.tiers] === 'recommended');
  }

  /**
   * Get hardware-aware recommendations: the best-fit LLMs for every locally runnable backend computed from the catalog (best
   * first; index 0 is what app bootstrap auto-installs), followed by the tier's recommended non-LLM
   * models (voice/STT). LLM sizing is derived from each model's real footprint vs. the hardware
   * budget, so it stays consistent with the catalog instead of a parallel hand-maintained table.
   */
  getRecommendedModelsForHardware(tier: HardwareTier, profile: HardwareProfile): CuratedModel[] {
    if (tier === 'insufficient') return [];
    const nonLlmRecommended = this.getRecommendedModels(tier, profile).filter((m) => m.modality !== 'llm');
    return [...this.selectLlmsForHardware(profile, tier), ...nonLlmRecommended];
  }

  /**
   * The default embedding model recommended for the tier, on a given backend (default
   * 'ollama' — the only backend with embedding models in the catalog until a given
   * backend gets its own, e.g. `nomic-embed-text-v1-lemonade`). Picked independently of
   * the chat LLM so memory/RAG consumers (e.g. the companion-memory app's pgvector
   * store) always receive a usable embeddings model. Returns null for an insufficient
   * tier, or when no embedding model is recommended for that backend — callers must
   * handle that gracefully (e.g. a Lemonade-only host with no Ollama installed) rather
   * than falling back to a different backend's model ID, which would be unreachable.
   */
  getRecommendedEmbeddingModel(tier: HardwareTier, backend: InferenceBackendType = 'ollama', profile?: HardwareProfile): CuratedModel | null {
    if (tier === 'insufficient') return null;
    return this.getRecommendedModels(tier, profile).find((m) => m.modality === 'embedding' && m.backend === backend) ?? null;
  }

  /**
   * The default vision-capable LLM recommended for the tier, on a given backend (default
   * 'ollama'). Vision models are standard LLMs with image input support — they're picked
   * from the LLM catalog entries that have `metadata.capabilities.vision === true` and
   * match the requested backend. Returns null when no vision model is available for the
   * tier on that backend.
   */
  getRecommendedVisionModel(tier: HardwareTier, backend: InferenceBackendType = 'ollama', profile?: HardwareProfile): CuratedModel | null {
    if (tier === 'insufficient') return null;
    const candidates = (profile ? this.getModelsForHardware(tier, profile) : this.getModelsForTier(tier)).filter(
      (m) => m.modality === 'llm' && m.backend === backend && m.metadata?.capabilities?.vision === true && !isCloudProxyModel(m),
    );
    if (candidates.length === 0) return null;
    candidates.sort(compareLlmCandidates);
    return candidates[0] ?? null;
  }

  /** Get default models to pin for a tier */
  getDefaultPinnedModels(tier: HardwareTier): CuratedModel[] {
    return this.getRecommendedModels(tier).filter((m) => m.runtime.pinnedByDefault);
  }

  /** Derive the usable inference memory budget (and target device) from the hardware profile. */
  private computeInferenceBudget(profile: HardwareProfile): InferenceBudget {
    const totalRamMb = profile.ram.totalMb;
    if (profile.gpu.unifiedMemory && GPU_INFERENCE_VENDORS.has(profile.gpu.vendor)) {
      // Shared-memory GPU (Apple Silicon, or an AMD APU): the GPU draws from system RAM
      // shared with the OS and apps. Only an x86 UMA APU is bandwidth-bound per token —
      // its "VRAM" is ordinary DDR/LPDDR system RAM. ARM unified-memory parts (Apple
      // Silicon, NVIDIA Grace) are purpose-built high-bandwidth and run dense models
      // well, so gate on the CPU arch rather than vendor (which also excludes them).
      return {
        budgetMb: Math.floor(totalRamMb * UNIFIED_MEMORY_BUDGET_FRACTION),
        cpuOnly: false,
        vendor: profile.gpu.vendor as GpuVendorKey,
        bandwidthConstrained: profile.cpu.arch === 'x86_64',
      };
    }
    if (profile.gpu.available && profile.gpu.vramMb > 0 && GPU_INFERENCE_VENDORS.has(profile.gpu.vendor)) {
      // Discrete GPU (nvidia/amd): the model must fit in dedicated VRAM.
      return {
        budgetMb: Math.floor(profile.gpu.vramMb * VRAM_BUDGET_FRACTION),
        cpuOnly: false,
        vendor: profile.gpu.vendor as GpuVendorKey,
        bandwidthConstrained: false,
      };
    }
    // No GPU Ollama can offload to (none, or unsupported like Intel): run on the CPU out of system RAM.
    return { budgetMb: Math.floor(totalRamMb * SYSTEM_RAM_BUDGET_FRACTION), cpuOnly: true, vendor: 'cpu', bandwidthConstrained: false };
  }

  /**
   * Compute the best-fit LLMs for the hardware, best first, across every backend represented in the
   * LLM catalog (currently 'ollama', 'vllm', 'lemonade', 'mtplx', 'dspark', and 'lucebox') — not just Ollama. Each backend's picks are
   * computed independently (its own best-fit ranking, size-spanning selection) and concatenated, so
   * `getRecommendedModelsForHardware`'s result naturally contains a per-backend recommendation without
   * callers needing to ask for one explicitly; a caller resolving a specific active backend (see
   * InferenceEnvResolver / AppCredentialsService) filters this list down to `m.backend === active`.
   * Adding a backend with no catalog rows yet is a no-op here — it simply contributes nothing.
   */
  private selectLlmsForHardware(profile: HardwareProfile, tier = profile.tier): CuratedModel[] {
    const tierAllowedIds = new Set(this.getModelsForHardware(tier, profile).map((m) => m.id));
    const budget = this.computeInferenceBudget(profile);
    const backends = new Set(CURATED_MODELS.filter((m) => m.modality === 'llm').map((m) => m.backend));

    return Array.from(backends).flatMap((backend) => {
      const picks = this.pickBestFittingLlms(budget, tierAllowedIds, backend);
      if (picks.length > 0 || budget.cpuOnly) {
        return picks;
      }
      // A discrete GPU too small to hold any model (e.g. 2GB VRAM): fall back to CPU inference out of
      // system RAM so a tiny-GPU box still gets a usable, size-capped pick.
      return this.pickBestFittingLlms(
        {
          budgetMb: Math.floor(profile.ram.totalMb * SYSTEM_RAM_BUDGET_FRACTION),
          cpuOnly: true,
          vendor: 'cpu',
          bandwidthConstrained: false,
        },
        tierAllowedIds,
        backend,
      );
    });
  }

  /**
   * Rank a given backend's catalog LLMs that fit a budget and return a short, best-first list that
   * spans small/medium/large size classes. Index 0 is always that backend's single best model (biggest
   * at q4+), which app bootstrap auto-installs; the remaining slots cover a useful range of smaller
   * options.
   */
  private pickBestFittingLlms(budget: InferenceBudget, tierAllowedIds: Set<string>, backend: InferenceBackendType): CuratedModel[] {
    const fitting = CURATED_MODELS.filter(
      (m) =>
        tierAllowedIds.has(m.id) &&
        m.backend === backend &&
        m.modality === 'llm' &&
        !isCloudProxyModel(m) &&
        m.requirements.gpuVendors.includes(budget.vendor) &&
        m.runtime.memoryFootprintMb <= budget.budgetMb &&
        (!budget.cpuOnly || (m.parameterScale ?? Number.POSITIVE_INFINITY) <= CPU_ONLY_MAX_PARAMETER_SCALE) &&
        // On a bandwidth-constrained APU, exclude high-active-param models: a large
        // dense model "fits" the shared budget but is too slow per token, so prefer
        // MoE / smaller-dense by active size.
        (!budget.bandwidthConstrained || activeParamsOf(m) <= APU_MAX_ACTIVE_PARAMS_B),
    );
    fitting.sort(compareLlmCandidates);

    // Collapse quant variants of the same model down to one best entry per model, best first.
    const distinct: CuratedModel[] = [];
    const seenBaseIds = new Set<string>();
    for (const model of fitting) {
      const baseId = model.id.replace(QUANT_SUFFIX_RE, '');
      if (seenBaseIds.has(baseId)) continue;
      seenBaseIds.add(baseId);
      distinct.push(model);
    }
    if (distinct.length <= MAX_RECOMMENDED_LLMS) return distinct;

    // Build a size-spanning selection: the overall best, then the best of each size class present,
    // then fill remaining slots with the next-best models. Re-sorted best-first so index 0 stays
    // the single best model for auto-install.
    const selected: CuratedModel[] = [];
    const selectedIds = new Set<string>();
    const add = (model: CuratedModel | undefined) => {
      if (model && !selectedIds.has(model.id)) {
        selected.push(model);
        selectedIds.add(model.id);
      }
    };

    add(distinct[0]);
    for (const sizeClass of SIZE_CLASS_ORDER) {
      if (selected.length >= MAX_RECOMMENDED_LLMS) break;
      add(distinct.find((m) => sizeClassOf(m) === sizeClass));
    }
    for (const model of distinct) {
      if (selected.length >= MAX_RECOMMENDED_LLMS) break;
      add(model);
    }

    selected.sort(compareLlmCandidates);
    return selected;
  }

  /** Get models by modality */
  getModelsByModality(modality: ModelModality): CuratedModel[] {
    return CURATED_MODELS.filter((m) => m.modality === modality);
  }

  /** Get models for a specific backend */
  getModelsByBackend(backend: InferenceBackendType): CuratedModel[] {
    return CURATED_MODELS.filter((m) => m.backend === backend);
  }

  /** Look up a curated model by ID */
  getCuratedModel(modelId: string): CuratedModel | undefined {
    return CURATED_MODELS.find((m) => m.id === modelId);
  }

  // ─── Tracked Model State ──────────────────────────────────────────────

  /** Get all tracked models */
  getTrackedModels(): TrackedModel[] {
    return Array.from(this.trackedModels.values());
  }

  /** Get a specific tracked model */
  getTrackedModel(catalogId: string): TrackedModel | undefined {
    return this.trackedModels.get(catalogId);
  }

  /** Track a model (when pulling or loading) */
  trackModel(catalogId: string, state: ModelState, backendModelId?: string): TrackedModel {
    const curated = this.getCuratedModel(catalogId);
    const existing = this.trackedModels.get(catalogId);

    const tracked: TrackedModel = {
      catalogId,
      backend: curated?.backend ?? existing?.backend ?? 'ollama',
      backendModelId: backendModelId ?? curated?.backendModelId ?? catalogId,
      state,
      pinned: existing?.pinned ?? false,
      memoryUsedMb: existing?.memoryUsedMb ?? curated?.runtime.memoryFootprintMb ?? 0,
      lastUsedAt: existing?.lastUsedAt,
      requestCount: existing?.requestCount ?? 0,
      pullProgress: state === 'pulling' ? (existing?.pullProgress ?? 0) : undefined,
    };

    this.trackedModels.set(catalogId, tracked);
    return tracked;
  }

  /** Update model state */
  updateModelState(catalogId: string, state: ModelState, errorMessage?: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.state = state;
      if (errorMessage) tracked.errorMessage = errorMessage;
      if (state === 'pinned') tracked.pinned = true;
      if (state === 'loaded' || state === 'pinned') {
        tracked.lastUsedAt = Date.now();
      }
    }
  }

  /** Update pull progress */
  updatePullProgress(catalogId: string, progress: number): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.pullProgress = progress;
    }
  }

  /** Pin a model */
  pinModel(catalogId: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.pinned = true;
      tracked.state = 'pinned';
    }
  }

  /** Unpin a model */
  unpinModel(catalogId: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.pinned = false;
      if (tracked.state === 'pinned') {
        tracked.state = 'loaded';
      }
    }
  }

  /** Record a model usage (for LRU eviction) */
  recordUsage(catalogId: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.lastUsedAt = Date.now();
      tracked.requestCount++;
    }
  }

  /** Get eviction candidates sorted by score (worst first) */
  getEvictionCandidates(): TrackedModel[] {
    return Array.from(this.trackedModels.values())
      .filter((m) => !m.pinned && m.state === 'loaded')
      .sort((a, b) => {
        // Score: lower = evict first
        const aLru = a.lastUsedAt ?? 0;
        const bLru = b.lastUsedAt ?? 0;
        // Oldest last used first
        if (aLru !== bLru) return aLru - bLru;
        // Fewest requests first
        return a.requestCount - b.requestCount;
      });
  }

  /** Remove a tracked model */
  removeTrackedModel(catalogId: string): void {
    this.trackedModels.delete(catalogId);
  }

  /** Get all pinned models */
  getPinnedModels(): TrackedModel[] {
    return Array.from(this.trackedModels.values()).filter((m) => m.pinned);
  }

  /** Get loaded models (loaded + pinned) */
  getLoadedModels(): TrackedModel[] {
    return Array.from(this.trackedModels.values()).filter((m) => m.state === 'loaded' || m.state === 'pinned');
  }
}
