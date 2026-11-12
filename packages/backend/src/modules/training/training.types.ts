/**
 * The closed sets a manifest is checked against. Kept as values, not only as types, so the request
 * schema in `training.dto.ts` and the types below cannot drift apart.
 */
export const TRAINING_JOB_TYPES = [
  'hbpe_bootstrap_hmt',
  'hbpe_nightly_lora',
  'llm_lora_finetune',
  'embedding_adaptation',
  'unsloth_decision_train',
] as const;
export type TrainingJobType = (typeof TRAINING_JOB_TYPES)[number];

export const TRAINING_DEVICES = ['auto', 'cuda', 'mps', 'cpu'] as const;
export type TrainingDevice = (typeof TRAINING_DEVICES)[number];

export const TRAINING_FRAMEWORKS = ['pytorch', 'mlx', 'tinygrad', 'unsloth'] as const;
export const TRAINING_TARGET_FORMATS = ['onnx_int8', 'pytorch_lora', 'mlx_adapter', 'unsloth_decision_lora'] as const;
export const TRAINING_DATASET_FORMATS = ['token_stream_jsonl', 'arrow', 'parquet'] as const;
export const TRAINING_PRIORITIES = ['interactive', 'normal', 'nightly_idle'] as const;

/**
 * A job id names the job's artifact directory (`.internal/training/<jobId>`), so it is held to the
 * characters a single path segment can safely carry. The request schema checks it, and
 * `TrainingRunnerService.submitJob` checks it again for callers that do not come through a request.
 */
export const TRAINING_JOB_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type TrainingJobState =
  | 'QUEUED'
  | 'ACQUIRING_RESOURCES'
  | 'DATA_STAGING'
  | 'RUNNING'
  | 'EVALUATING'
  | 'EXPORTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DEFERRED';

export interface TrainingJobManifest {
  jobId: string;
  appId: string;
  jobType: TrainingJobType;
  /**
   * Read by the HBPE trainer (`ci.hbpe.model.train_runner`) to say whose artifacts these are. Not
   * used by the Hub itself; declared so request validation keeps it on its way to the trainer.
   */
  userId?: string;

  model: {
    backboneId: string;
    framework: (typeof TRAINING_FRAMEWORKS)[number];
    targetFormat: (typeof TRAINING_TARGET_FORMATS)[number];
    baseCheckpointPath?: string;
  };

  dataset: {
    format: (typeof TRAINING_DATASET_FORMATS)[number];
    dataPath: string;
    trainDaysCount?: number;
    valFraction: number;
  };

  hyperparameters: {
    batchSize: number;
    learningRate: number;
    epochs: number;
    weightDecay?: number;
    loraRank?: number;
    loraAlpha?: number;
    patience?: number;
    mixedPrecision: boolean;
  };

  resourcePolicy: {
    devicePreference: TrainingDevice;
    maxVramMb?: number;
    allowRemoteOffload: boolean;
    priority: (typeof TRAINING_PRIORITIES)[number];
    timeoutSeconds: number;
  };
}

export interface TrainingProgressEvent {
  jobId: string;
  phase: string;
  epoch: number;
  totalEpochs: number;
  trainLoss: number;
  valLoss: number | null;
  learningRate: number;
  elapsedSeconds: number;
  etaSeconds: number;
  device: string;
  timestamp: string;
}

export interface TrainingJobStatus {
  jobId: string;
  appId: string;
  jobType: TrainingJobType;
  state: TrainingJobState;
  executedOnNode: string; // "local" or peer FQDN (e.g. "desktop.ts.net")
  currentEpoch: number;
  totalEpochs: number;
  trainLoss: number;
  valLoss: number | null;
  progressPercent: number;
  etaSeconds: number;
  errorMessage?: string;
  artifacts?: {
    modelPath: string;
    metricsSummaryPath?: string;
    checksumSha256?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TrainingPeerCapability {
  nodeFqdn: string;
  hardwareTier: string;
  acceptingTrainingJobs: boolean;
  availableVramMb: number;
  gpuPressure: number;
  supportedFrameworks: string[];
  activeTrainingJobs: number;
  lastUpdated: string;
}
