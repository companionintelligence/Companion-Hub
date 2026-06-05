import type { CuratedModel } from '@ci-hub/common/types';

export interface SelectionBudgetResult {
  downloadDiskMb: number;
  /** Sum of runtime.memoryFootprintMb for selected models not yet in Ollama — inference RAM/VRAM at load time, not download size. */
  newMemoryMb: number;
  /** Sum of runtime.memoryFootprintMb for selected models already present in Ollama. */
  installedMemoryMb: number;
  /** Total footprint of all selected models (informational). */
  totalMemoryMb: number;
  overDisk: boolean;
  /** Advisory only — does not block onboarding. */
  overMemory: boolean;
  /** Non-blocking note when installed models are selected. */
  memoryNote?: string;
  /** Blocks onboarding when disk for new downloads is insufficient. */
  diskReason?: string;
  /** Advisory when new selections exceed free inference memory (runtime footprint, not download size). */
  memoryWarning?: string;
}

function formatSizeMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export function computeSelectionBudget(
  selectedModels: CuratedModel[],
  installedCatalogIds: string[],
  availableDiskMb: number,
  availableMemoryMb: number,
): SelectionBudgetResult {
  const installed = new Set(installedCatalogIds);
  const modelsNeedingDownload = selectedModels.filter((m) => !installed.has(m.id));
  const modelsAlreadyInstalled = selectedModels.filter((m) => installed.has(m.id));

  const downloadDiskMb = modelsNeedingDownload.reduce((sum, m) => sum + (m.requirements?.diskMb ?? 0), 0);
  const newMemoryMb = modelsNeedingDownload.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);
  const installedMemoryMb = modelsAlreadyInstalled.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);
  const totalMemoryMb = selectedModels.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);

  const overDisk = downloadDiskMb > availableDiskMb;
  const overMemory = newMemoryMb > availableMemoryMb;

  let memoryNote: string | undefined;
  if (modelsAlreadyInstalled.length > 0 && modelsNeedingDownload.length === 0) {
    memoryNote =
      modelsAlreadyInstalled.length === 1
        ? 'This model is already in Ollama — nothing new to download.'
        : `${modelsAlreadyInstalled.length} selected models are already in Ollama — nothing new to download.`;
  } else if (installedMemoryMb > 0) {
    const installedCount = modelsAlreadyInstalled.length;
    memoryNote =
      installedCount === 1
        ? `One selected model (${formatSizeMb(installedMemoryMb)} runtime footprint) is already in Ollama and will not be downloaded again.`
        : `${installedCount} selected models (${formatSizeMb(installedMemoryMb)} combined runtime footprint) are already in Ollama and will not be downloaded again.`;
  }

  let diskReason: string | undefined;
  if (overDisk) {
    diskReason = `Selected downloads need ${formatSizeMb(downloadDiskMb)} disk space, but only ${formatSizeMb(availableDiskMb)} is available. Deselect models or free disk space before continuing.`;
  }

  let memoryWarning: string | undefined;
  if (overMemory) {
    memoryWarning = `New model selections may need ${formatSizeMb(newMemoryMb)} inference memory at runtime, but only ${formatSizeMb(availableMemoryMb)} is currently free. You can continue — Hub will attempt best-effort downloads, but some models may not load until memory is freed.`;
  }

  return {
    downloadDiskMb,
    newMemoryMb,
    installedMemoryMb,
    totalMemoryMb,
    overDisk,
    overMemory,
    memoryNote,
    diskReason,
    memoryWarning,
  };
}

/** True when new downloads fit on disk. Inference memory overages are advisory only. */
export function isSelectionWithinBudget(
  selectedModels: CuratedModel[],
  installedCatalogIds: string[],
  availableDiskMb: number,
  _availableMemoryMb: number,
): boolean {
  const result = computeSelectionBudget(selectedModels, installedCatalogIds, availableDiskMb, _availableMemoryMb);
  return !result.overDisk;
}
