import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type {
  CuratedModel,
  HardwareProfile,
  HardwareTier,
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

/**
 * Order LLM candidates best-first. The primary key is the Artificial Analysis Intelligence Index
 * (higher = smarter) so the best-fit default is the most capable model that fits the hardware — not
 * merely the largest. Models without a measured index score 0 (we can't claim intelligence we haven't
 * measured), so a scored model is preferred over an unscored one of any size. Remaining ties fall back
 * to the prior heuristics: q4+ before sub-q4, then bigger parameter count, then higher-fidelity quant.
 */
function compareLlmCandidates(a: CuratedModel, b: CuratedModel): number {
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

  /** Filter catalog by hardware tier */
  getModelsForTier(tier: HardwareTier): CuratedModel[] {
    const tierKey = tier === 'cpu-only' ? 'cpuOnly' : tier;
    if (tier === 'insufficient') return [];
    return CURATED_MODELS.filter((m) => {
      const rec = m.tiers[tierKey as keyof typeof m.tiers];
      return rec === 'recommended' || rec === 'available';
    });
  }

  /** Get recommended models for a tier (default pulls) */
  getRecommendedModels(tier: HardwareTier): CuratedModel[] {
    const tierKey = tier === 'cpu-only' ? 'cpuOnly' : tier;
    if (tier === 'insufficient') return [];
    return CURATED_MODELS.filter((m) => m.tiers[tierKey as keyof typeof m.tiers] === 'recommended');
  }

  /**
   * Get hardware-aware recommendations: the best-fit Ollama LLMs computed from the catalog (best
   * first; index 0 is what app bootstrap auto-installs), followed by the tier's recommended non-LLM
   * models (voice/STT). LLM sizing is derived from each model's real footprint vs. the hardware
   * budget, so it stays consistent with the catalog instead of a parallel hand-maintained table.
   */
  getRecommendedModelsForHardware(tier: HardwareTier, profile: HardwareProfile): CuratedModel[] {
    if (tier === 'insufficient') return [];
    const nonLlmRecommended = this.getRecommendedModels(tier).filter((m) => m.modality !== 'llm');
    return [...this.selectLlmsForHardware(profile), ...nonLlmRecommended];
  }

  /**
   * The default embedding model recommended for the tier. Picked independently of
   * the chat LLM so memory/RAG consumers (e.g. the companion-memory app's pgvector
   * store) always receive a usable embeddings model. Returns null for an
   * insufficient tier or when no embedding model is recommended.
   */
  getRecommendedEmbeddingModel(tier: HardwareTier): CuratedModel | null {
    if (tier === 'insufficient') return null;
    return this.getRecommendedModels(tier).find((m) => m.modality === 'embedding') ?? null;
  }

  /**
   * The default vision-capable LLM recommended for the tier. Vision models are
   * standard LLMs with image input support — they're picked from the LLM catalog
   * entries that have `metadata.capabilities.vision === true`. Returns null when no
   * vision model is available for the tier.
   */
  getRecommendedVisionModel(tier: HardwareTier): CuratedModel | null {
    if (tier === 'insufficient') return null;
    const candidates = this.getModelsForTier(tier).filter((m) => m.modality === 'llm' && m.metadata?.capabilities?.vision === true);
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
      // Apple Silicon: the GPU draws from system RAM shared with the OS and apps.
      return { budgetMb: Math.floor(totalRamMb * UNIFIED_MEMORY_BUDGET_FRACTION), cpuOnly: false, vendor: profile.gpu.vendor as GpuVendorKey };
    }
    if (profile.gpu.available && profile.gpu.vramMb > 0 && GPU_INFERENCE_VENDORS.has(profile.gpu.vendor)) {
      // Discrete GPU (nvidia/amd): the model must fit in dedicated VRAM.
      return { budgetMb: Math.floor(profile.gpu.vramMb * VRAM_BUDGET_FRACTION), cpuOnly: false, vendor: profile.gpu.vendor as GpuVendorKey };
    }
    // No GPU Ollama can offload to (none, or unsupported like Intel): run on the CPU out of system RAM.
    return { budgetMb: Math.floor(totalRamMb * SYSTEM_RAM_BUDGET_FRACTION), cpuOnly: true, vendor: 'cpu' };
  }

  /**
   * Compute the best-fit Ollama LLMs for the hardware, best first. Single source of truth: a model's
   * own footprint vs. the hardware budget. Prefers the largest model that fits at q4 or better, only
   * falling back to sub-q4 quants when nothing else fits, and caps CPU-only picks to small/fast models.
   */
  private selectLlmsForHardware(profile: HardwareProfile): CuratedModel[] {
    const budget = this.computeInferenceBudget(profile);
    const picks = this.pickBestFittingLlms(budget);
    if (picks.length > 0 || budget.cpuOnly) {
      return picks;
    }
    // A discrete GPU too small to hold any model (e.g. 2GB VRAM): fall back to CPU inference out of
    // system RAM — Ollama offloads to CPU — so a tiny-GPU box still gets a usable, size-capped pick.
    return this.pickBestFittingLlms({
      budgetMb: Math.floor(profile.ram.totalMb * SYSTEM_RAM_BUDGET_FRACTION),
      cpuOnly: true,
      vendor: 'cpu',
    });
  }

  /**
   * Rank the catalog's Ollama LLMs that fit a given budget and return a short, best-first list that
   * spans small/medium/large size classes. Index 0 is always the single best model (biggest at q4+),
   * which app bootstrap auto-installs; the remaining slots cover a useful range of smaller options.
   */
  private pickBestFittingLlms(budget: InferenceBudget): CuratedModel[] {
    const fitting = CURATED_MODELS.filter(
      (m) =>
        m.backend === 'ollama' &&
        m.modality === 'llm' &&
        m.requirements.gpuVendors.includes(budget.vendor) &&
        m.runtime.memoryFootprintMb <= budget.budgetMb &&
        (!budget.cpuOnly || (m.parameterScale ?? Number.POSITIVE_INFINITY) <= CPU_ONLY_MAX_PARAMETER_SCALE),
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
