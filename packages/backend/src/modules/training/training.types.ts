export type TrainingJobType = 'hbpe_bootstrap_hmt' | 'hbpe_nightly_lora' | 'llm_lora_finetune' | 'embedding_adaptation' | 'unsloth_decision_train';

export type TrainingDevice = 'auto' | 'cuda' | 'mps' | 'cpu';

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

  model: {
    backboneId: string;
    framework: 'pytorch' | 'mlx' | 'tinygrad' | 'unsloth';
    targetFormat: 'onnx_int8' | 'pytorch_lora' | 'mlx_adapter' | 'unsloth_decision_lora';
    baseCheckpointPath?: string;
  };

  dataset: {
    format: 'token_stream_jsonl' | 'arrow' | 'parquet';
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
    priority: 'interactive' | 'normal' | 'nightly_idle';
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
