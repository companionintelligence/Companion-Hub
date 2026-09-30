import type { CuratedModel } from '@ci-hub/common/types';

export interface SelectionBudgetResult {
  downloadDiskMb: number;
  /** Sum of runtime.memoryFootprintMb for selected models not yet on the engine — inference RAM/VRAM at load time, not download size. */
  newMemoryMb: number;
  /** Sum of runtime.memoryFootprintMb for selected models already present on the engine. */
  installedMemoryMb: number;
  /** Total footprint of all selected models (informational). */
  totalMemoryMb: number;
  overDisk: boolean;
  /** Non-blocking note when installed models are selected. */
  memoryNote?: string;
  /** Blocks onboarding when disk for new downloads is insufficient. */
  diskReason?: string;
}

function formatSizeMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

/**
 * What a selection costs in DISK, plus the note about models that need no download. Nothing here
 * judges inference memory against the selection: downloading a model touches no GPU, and loading
 * one is the router's job — it fits, evicts or refuses per load (see the Hub's `loadTrackedModel`).
 * Until 2026-09-30 this also warned "new selections may need X GB but only Y GB is free", which
 * compared a download decision with what happened to be resident at the time.
 */
export function computeSelectionBudget(
  selectedModels: CuratedModel[],
  installedCatalogIds: string[],
  availableDiskMb: number,
  /** The selected engine, as the notes should name it ("already in Lemonade"). */
  backendName = 'Ollama',
): SelectionBudgetResult {
  const installed = new Set(installedCatalogIds);
  const modelsNeedingDownload = selectedModels.filter((m) => !installed.has(m.id));
  const modelsAlreadyInstalled = selectedModels.filter((m) => installed.has(m.id));

  const downloadDiskMb = modelsNeedingDownload.reduce((sum, m) => sum + (m.requirements?.diskMb ?? 0), 0);
  const newMemoryMb = modelsNeedingDownload.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);
  const installedMemoryMb = modelsAlreadyInstalled.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);
  const totalMemoryMb = selectedModels.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);

  const overDisk = downloadDiskMb > availableDiskMb;

  let memoryNote: string | undefined;
  if (modelsAlreadyInstalled.length > 0 && modelsNeedingDownload.length === 0) {
    memoryNote =
      modelsAlreadyInstalled.length === 1
        ? `This model is already in ${backendName}. Nothing new to download.`
        : `${modelsAlreadyInstalled.length} selected models are already in ${backendName}. Nothing new to download.`;
  } else if (installedMemoryMb > 0) {
    const installedCount = modelsAlreadyInstalled.length;
    memoryNote =
      installedCount === 1
        ? `One selected model (${formatSizeMb(installedMemoryMb)} runtime footprint) is already in ${backendName} and will not be downloaded again.`
        : `${installedCount} selected models (${formatSizeMb(installedMemoryMb)} combined runtime footprint) are already in ${backendName} and will not be downloaded again.`;
  }

  let diskReason: string | undefined;
  if (overDisk) {
    diskReason = `Selected downloads need ${formatSizeMb(downloadDiskMb)} disk space, but only ${formatSizeMb(availableDiskMb)} is available. Deselect models or free disk space before continuing.`;
  }

  return {
    downloadDiskMb,
    newMemoryMb,
    installedMemoryMb,
    totalMemoryMb,
    overDisk,
    memoryNote,
    diskReason,
  };
}

/** True when new downloads fit on disk — the one thing a selection can be over. */
export function isSelectionWithinBudget(selectedModels: CuratedModel[], installedCatalogIds: string[], availableDiskMb: number): boolean {
  return !computeSelectionBudget(selectedModels, installedCatalogIds, availableDiskMb).overDisk;
}

/**
 * The inference memory the engines may use on this host, and how much of it is free right now —
 * VRAM on a discrete GPU, the model share of RAM otherwise. Mirrors `availableMemoryMb` in the
 * Hub's onboarding profile, which is the same budget minus what every engine holds.
 */
export function inferenceMemoryMb(profile: {
  hardware: { gpu: { available: boolean; unifiedMemory: boolean } };
  memoryBudget: { modelBudgetVramMb: number; modelBudgetRamMb: number };
  resourceEstimate: { availableMemoryMb: number };
}): { totalMb: number; freeMb: number } {
  const { gpu } = profile.hardware;
  const totalMb = gpu.available && !gpu.unifiedMemory ? profile.memoryBudget.modelBudgetVramMb : profile.memoryBudget.modelBudgetRamMb;
  return { totalMb: Math.max(0, totalMb), freeMb: Math.max(0, Math.min(totalMb, profile.resourceEstimate.availableMemoryMb ?? 0)) };
}
