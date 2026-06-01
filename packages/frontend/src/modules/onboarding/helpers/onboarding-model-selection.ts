import type { CuratedModel } from '@ci-hub/common/types';

export interface SelectionBudgetResult {
  downloadDiskMb: number;
  totalMemoryMb: number;
  overDisk: boolean;
  overMemory: boolean;
  reason?: string;
}

export function computeSelectionBudget(
  selectedModels: CuratedModel[],
  installedCatalogIds: string[],
  availableDiskMb: number,
  availableMemoryMb: number,
): SelectionBudgetResult {
  const installed = new Set(installedCatalogIds);
  const downloadDiskMb = selectedModels.filter((m) => !installed.has(m.id)).reduce((sum, m) => sum + (m.requirements?.diskMb ?? 0), 0);
  const totalMemoryMb = selectedModels.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);

  const overDisk = downloadDiskMb > availableDiskMb;
  const overMemory = totalMemoryMb > availableMemoryMb;

  let reason: string | undefined;
  if (overDisk && overMemory) {
    reason = 'Selected downloads exceed available disk space and selected models exceed available inference memory.';
  } else if (overDisk) {
    reason = 'Selected downloads exceed available disk space. Deselect models or free disk space before continuing.';
  } else if (overMemory) {
    reason = 'Selected models exceed available inference memory. Choose smaller models or add a cloud provider.';
  }

  return { downloadDiskMb, totalMemoryMb, overDisk, overMemory, reason };
}

export function isSelectionWithinBudget(
  selectedModels: CuratedModel[],
  installedCatalogIds: string[],
  availableDiskMb: number,
  availableMemoryMb: number,
): boolean {
  const result = computeSelectionBudget(selectedModels, installedCatalogIds, availableDiskMb, availableMemoryMb);
  return !result.overDisk && !result.overMemory;
}
