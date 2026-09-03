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

export type PullStartStatus = 'already_installed' | 'queued' | 'in_progress' | 'skipped' | 'error';

export interface PullStartResult {
  catalogId: string;
  status: PullStartStatus;
  reason?: string;
}
