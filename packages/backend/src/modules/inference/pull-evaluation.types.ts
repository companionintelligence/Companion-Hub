export interface PullEvaluation {
  catalogId: string;
  alreadyInstalled: boolean;
  canPull: boolean;
  reason?: string;
  requiredDiskMb: number;
  requiredMemoryMb: number;
  availableDiskMb: number;
  availableMemoryMb: number;
}
