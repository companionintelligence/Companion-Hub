export interface PullEvaluation {
  catalogId: string;
  alreadyInstalled: boolean;
  canPull: boolean;
  reason?: string;
  /**
   * Set only with `canPull: true`: the download goes ahead, but something about it may disappoint,
   * such as a catalog estimate larger than this node's model memory. Logged when the pull is queued.
   */
  warning?: string;
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
