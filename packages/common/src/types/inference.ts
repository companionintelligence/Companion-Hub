import type { HostPlatform } from './host-metrics.js';

// ─── Hardware Detection ─────────────────────────────────────────────────────

export interface HardwareProfile {
  gpu: {
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'none';
    model: string;
    vramMb: number;
    unifiedMemory: boolean;
    driverVersion: string;
    /** Container GPU runtime (e.g. ROCm/NVIDIA device passthrough). Optional on older profiles. */
    runtimeAvailable: boolean;
    /** Host ROCm stack detected via init-gpu-runtime probe. Linux AMD only; optional on older profiles. */
    hostRocmAvailable?: boolean;
    /** Host /dev/kfd is available for ROCm container apps (ComfyUI, etc.). Optional on older profiles. */
    hostRocmKfdAvailable?: boolean;
    /**
     * Which Docker backend the daemon is (from `docker info` OS/kernel). Drives GPU
     * setup guidance: Docker Desktop manages the container GPU runtime itself, a
     * native engine inside WSL2 needs nvidia-container-toolkit installed in the
     * distro, and native Linux needs it on the host. Optional on older profiles.
     */
    containerHostKind?: 'docker-desktop' | 'wsl-engine' | 'native-linux' | 'unknown';
  };
  npu: {
    available: boolean;
    model: string;
  };
  ram: {
    totalMb: number;
    availableMb: number;
  };
  cpu: {
    arch: 'x86_64' | 'arm64';
    cores: number;
    model: string;
  };
  /** Host operating system. Optional — absent on older profiles / test fixtures. */
  os?: {
    /** Node platform: 'darwin' | 'linux' | 'win32'. */
    platform: string;
    /** Friendly OS name, e.g. 'macOS', 'Ubuntu', 'Windows'. */
    name: string;
    /** Release codename when known (e.g. 'Tahoe', 'Sequoia'), else the numeric release. */
    version: string;
  };
  effectiveInferenceMemoryMb: number;
  tier: HardwareTier;
}

export type HardwareTier = 'high' | 'medium' | 'low' | 'cpu-only' | 'insufficient';

// ─── Memory Management ─────────────────────────────────────────────────────

export interface MemoryBudget {
  totalVramMb: number;
  totalRamMb: number;
  systemReservedRamMb: number;
  dockerOverheadMb: number;
  appContainerBudgetMb: number;
  modelBudgetVramMb: number;
  modelBudgetRamMb: number;
  modelUsedVramMb: number;
  modelUsedRamMb: number;
  pinnedVramMb: number;
  pinnedRamMb: number;
}

// ─── Model Registry ─────────────────────────────────────────────────────────

/**
 * Every local inference backend, in the order status/listing endpoints report them.
 *
 * The single source of truth: {@link InferenceBackendType} is *derived* from this tuple rather than
 * declared beside it, so the union and the list cannot drift. Callers that need to walk every
 * backend must iterate this instead of writing their own literal array — the hand-maintained copies
 * this replaced were all typed `InferenceBackendType[]` (or built from injected instances), which
 * accepts a *subset* without complaint, so a newly added backend silently vanished from
 * `getStatus().backends`, the discovered-model list, `hub_list_inference_backends`, and pool
 * candidate selection with no compile error anywhere.
 */
export const INFERENCE_BACKEND_TYPES = ['ollama', 'vllm', 'lemonade', 'mtplx', 'dspark', 'lucebox'] as const;

export type InferenceBackendType = (typeof INFERENCE_BACKEND_TYPES)[number];

export type ModelModality = 'llm' | 'tts' | 'stt' | 'image-gen' | 'embedding';
export type ModelPurpose = 'general' | 'coding' | 'reasoning' | 'fast' | 'voice' | 'transcription' | 'image' | 'embedding';

export type ModelState = 'available' | 'pulling' | 'pulled' | 'loading' | 'loaded' | 'pinned' | 'unloading' | 'error';

export type TierRecommendation = 'recommended' | 'available' | 'not-recommended';

export interface CuratedModel {
  id: string;
  backend: InferenceBackendType;
  backendModelId: string;
  modality: ModelModality;
  purpose: ModelPurpose;
  displayName: string;
  description: string;
  /**
   * Approximate parameter count in billions. Drives hardware-fit ranking
   * (bigger = more capable) and the CPU-only size cap. Set for LLMs; omitted
   * for non-sized modalities like TTS/STT.
   */
  parameterScale?: number;
  /**
   * Approximate ACTIVE parameter count in billions — the parameters actually read
   * per token. For dense models this equals `parameterScale`; for Mixture-of-Experts
   * (MoE) models it is the active-expert size (e.g. Qwen3-30B-A3B → 3), which is far
   * smaller than the total and is what governs per-token memory bandwidth on
   * shared-memory GPUs (Apple unified memory / AMD-Intel APUs). Falls back to
   * `parameterScale` when unspecified.
   */
  activeParameterScale?: number;
  requirements: {
    minVramMb: number;
    recommendedVramMb: number;
    minRamMb: number;
    diskMb: number;
    gpuVendors: ('nvidia' | 'amd' | 'intel' | 'apple' | 'cpu')[];
    /** Host platforms on which this backend/model combination is runnable locally. */
    supportedPlatforms?: HostPlatform[];
    npuRequired: boolean;
    minTier: HardwareTier;
  };
  runtime: {
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    input: ('text' | 'image' | 'audio')[];
    quantization?: string;
    pinnedByDefault: boolean;
    memoryFootprintMb: number;
  };
  tiers: {
    high: TierRecommendation;
    medium: TierRecommendation;
    low: TierRecommendation;
    cpuOnly: TierRecommendation;
  };
  /**
   * Reference metadata sourced from the Artificial Analysis open-weights leaderboard
   * (artificialanalysis.ai, snapshot 2026-05). Optional: `creator`/`capabilities` are set for every
   * catalog LLM; `intelligenceIndex` and `perf` only for models present on the leaderboard. `perf`
   * figures are AA's cloud-hosted measurements — indicative only, since local speed depends on the
   * user's own hardware and quantization.
   */
  metadata?: {
    /** Model creator / lab, e.g. "Meta", "Alibaba", "DeepSeek". */
    creator?: string;
    /** Artificial Analysis Intelligence Index (higher = more capable). */
    intelligenceIndex?: number;
    /** Artificial Analysis agentic / tool-calling index (higher = better at tool use). */
    toolCallingIndex?: number;
    capabilities?: {
      reasoning?: boolean;
      vision?: boolean;
      tools?: boolean;
      audio?: boolean;
    };
    perf?: {
      /** Median output tokens/second (AA cloud reference). */
      tokensPerSec?: number;
      /** Median latency to first chunk, seconds (AA cloud reference). */
      firstChunkSeconds?: number;
      /** Median end-to-end response time, seconds (AA cloud reference). */
      totalResponseSeconds?: number;
    };
  };
}

export interface TrackedModel {
  catalogId: string;
  backend: InferenceBackendType;
  backendModelId: string;
  state: ModelState;
  pinned: boolean;
  pullProgress?: number;
  memoryUsedMb: number;
  lastUsedAt?: number;
  requestCount: number;
  errorMessage?: string;
}

// ─── Inference Router ───────────────────────────────────────────────────────

export type CloudProviderType = 'openai' | 'anthropic' | 'google' | 'github-copilot';

export interface CloudProviderConfig {
  provider: CloudProviderType;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  enabled: boolean;
}

export interface InferenceModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  state: ModelState | 'available';
  backend: InferenceBackendType | 'cloud';
  modality: string[];
  local: boolean;
  context_window?: number;
  max_tokens?: number;
}

export interface InferenceStatus {
  hardwareTier: HardwareTier;
  backends: Array<{
    type: InferenceBackendType;
    running: boolean;
    healthy: boolean;
    url: string;
    modelsLoaded: number;
    /**
     * Models this backend is currently withholding because it was observed unable to serve them
     * (see `BackendHealthStatus.unservableModels`). Carried in BOTH id spaces — the engine-native
     * id and, where it maps onto the catalog, the catalog id — because the consumers hold one or
     * the other and none of them has a lookup table. Absent when nothing is withheld.
     */
    unservableModels?: string[];
  }>;
  models: InferenceModelInfo[];
  memoryBudget: MemoryBudget;
  cloudProviders: Array<{
    provider: CloudProviderType;
    enabled: boolean;
    configured: boolean;
  }>;
}

// ─── Backend Interface ──────────────────────────────────────────────────────

export interface BackendHealthStatus {
  running: boolean;
  healthy: boolean;
  /**
   * The backend's model *inventory* — what it has on disk and would accept a request for. It is
   * NOT proof that any of them can be served: Ollama's `/api/tags` happily lists a model whose
   * every `/api/generate` answers `model failed to load`. Read {@link unservableModels} alongside
   * it before routing work anywhere.
   */
  modelsLoaded: string[];
  /**
   * Ids from {@link modelsLoaded} the backend has actually been observed failing to serve, and is
   * withholding until that observation decays. Absent (rather than empty) when nothing is
   * withheld, so the common case is byte-identical to what this type carried before.
   *
   * This is the serving-capability half of the health contract, deliberately kept apart from
   * `modelsLoaded`: the inventory drives "is it installed" questions (the model puller, the
   * catalog's installed badge) that must keep seeing a model that is on disk but currently
   * unloadable, while routing must not.
   */
  unservableModels?: string[];
  error?: string;
}

/**
 * One model the engine says is IN MEMORY right now — not on disk.
 *
 * This type exists because `BackendHealthStatus.modelsLoaded` does not mean what its name
 * says (see its doc): it is inventory. Every field here is nullable on purpose, because
 * engines differ in what they will admit to, and a null that means "the engine did not
 * say" must never be rendered as a zero.
 */
export interface ResidentModel {
  id: string;
  /**
   * Bytes the engine's scheduler assigned to its GPU BACKEND. This is not a GPU memory
   * reading and must never be labelled VRAM.
   *
   * Measured on beta-max (Strix Halo, unified memory): the card's total VRAM is 2048 MB,
   * and ollama reported 7674223656 (7319 MiB) for a single 9B model — 3.5x the whole card.
   * Most of that allocation lives in host RAM reached through GTT. Calling this "bytes in
   * VRAM" would repeat, one level down, the exact mistake this type exists to correct:
   * "loaded means on disk" becoming "in VRAM means in host RAM".
   *
   * `null` when the engine reports residency but not size — most of them do not.
   */
  engineGpuBytes: number | null;
  /**
   * Total bytes the engine attributes to the model. Do NOT infer CPU offload from
   * `totalBytes - engineGpuBytes`: on every node in the current fleet those two are equal
   * while up to 83% of the allocation is physically in host RAM, so the difference is a
   * scheduler bookkeeping artefact, not a placement measurement.
   */
  totalBytes: number | null;
  /** When the engine will evict it unless used again. `null` when it does not expire or does not say. */
  expiresAt: string | null;
  /**
   * The context window the model was actually loaded WITH, which is not necessarily the one
   * the catalog advertises — an engine short on memory will load a smaller window silently,
   * and that is a thing an operator debugging a truncated prompt needs to see.
   */
  contextLength: number | null;
  /** e.g. `Q4_K_M`. `null` when the engine does not report it. */
  quantization: string | null;
}

/**
 * What one backend can tell us about residency, and — as importantly — how it knows.
 *
 * `source` is not decoration. A caller must be able to tell "the engine was asked and said
 * nothing is loaded" from "this engine has no notion of loading", because the first is a
 * fact about the machine and the second is a fact about the software. Conflating them is
 * exactly the class of error that made `modelsLoaded` mean the wrong thing.
 */
export type ResidencySource =
  /** The engine was queried and answered — the only source that can report an empty list as a fact. */
  | 'measured'
  /** The engine serves exactly the model(s) it was started with, so its inventory IS its residency. */
  | 'implicit'
  /** The engine exposes no residency concept. `models` is null; it is not empty. */
  | 'unsupported'
  /** The engine could not be reached. `models` is null. */
  | 'unreachable';

export interface BackendResidency {
  backend: InferenceBackendType;
  source: ResidencySource;
  /** `null` whenever `source` is `unsupported` or `unreachable` — never an empty array in those cases. */
  models: ResidentModel[] | null;
  error?: string;
}

export interface ResidencyReport {
  backends: BackendResidency[];
  /** Models resident across all backends that could answer. */
  residentCount: number;
  sampledAt: string;
}

export interface BackendModelInfo {
  id: string;
  name: string;
  size: number;
  loaded: boolean;
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent: number;
}
