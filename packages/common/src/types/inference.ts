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

export type InferenceBackendType = 'ollama' | 'vllm' | 'lemonade';

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
  modelsLoaded: string[];
  error?: string;
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
