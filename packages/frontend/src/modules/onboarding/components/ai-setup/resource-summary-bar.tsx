import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { backendDisplayName } from '@/lib/inference/backend-names';
import { computeSelectionBudget } from '../../helpers/onboarding-model-selection';
import { useTranslation } from 'react-i18next';

interface ResourceSummaryBarProps {
  selectedModels: CuratedModel[];
  installedCatalogIds: string[];
  /** The selected engine, named in the notes ("already installed in Lemonade"). */
  backend: InferenceBackendType;
  /** Available disk space in MB — the bar tracks new download size only. */
  availableStorageMb: number;
  /**
   * The host's inference memory (VRAM on a discrete GPU, the model share of RAM otherwise) and how
   * much of it the engines have free right now. Shown as a plain gauge: the selection has no bearing
   * on it — downloading touches no GPU, and loading fits or evicts per load.
   */
  totalMemoryMb: number;
  availableMemoryMb: number;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export const ResourceSummaryBar = ({
  selectedModels,
  installedCatalogIds,
  backend,
  availableStorageMb,
  totalMemoryMb,
  availableMemoryMb,
}: ResourceSummaryBarProps) => {
  const { t } = useTranslation();
  const backendName = backendDisplayName(backend);
  const budget = computeSelectionBudget(selectedModels, installedCatalogIds, availableStorageMb, backendName);
  const diskPercent = availableStorageMb > 0 ? Math.min(100, Math.round((budget.downloadDiskMb / availableStorageMb) * 100)) : 0;
  const usedMemoryMb = Math.max(0, totalMemoryMb - availableMemoryMb);
  const memoryPercent = totalMemoryMb > 0 ? Math.min(100, Math.round((usedMemoryMb / totalMemoryMb) * 100)) : 0;

  if (selectedModels.length === 0) return null;

  const memorySummary = t('ONBOARDING_RESOURCE_MEMORY_FREE_TOTAL', {
    free: formatSize(availableMemoryMb),
    total: formatSize(totalMemoryMb),
  });

  return (
    <div className="rounded-lg border p-3 space-y-3" data-testid="resource-summary">
      <div>
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="font-medium">{t('ONBOARDING_RESOURCE_MODELS_SELECTED', { count: selectedModels.length })}</span>
          <span className={budget.overDisk ? 'text-destructive font-medium' : 'text-muted-foreground'}>
            {t('ONBOARDING_RESOURCE_DISK_DOWNLOAD_AVAILABLE', {
              download: formatSize(budget.downloadDiskMb),
              available: formatSize(availableStorageMb),
            })}
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-1.5 rounded-full transition-all duration-300 ${budget.overDisk ? 'bg-destructive' : 'bg-primary'}`}
            style={{ width: `${diskPercent}%` }}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="font-medium">{t('ONBOARDING_RESOURCE_INFERENCE_MEMORY')}</span>
          <span className="text-muted-foreground" data-testid="resource-memory-summary">
            {memorySummary}
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
          <div className="h-1.5 rounded-full bg-secondary transition-all duration-300" style={{ width: `${memoryPercent}%` }} />
        </div>
      </div>

      {budget.memoryNote && (
        <p className="text-xs text-muted-foreground" data-testid="resource-memory-note">
          {budget.memoryNote}
        </p>
      )}

      {budget.overDisk && budget.diskReason && (
        <p className="text-xs text-destructive" data-testid="resource-warning">
          {budget.diskReason}
        </p>
      )}
    </div>
  );
};
