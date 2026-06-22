import type { CuratedModel } from '@ci-hub/common/types';
import { computeSelectionBudget } from '../../helpers/onboarding-model-selection';
import { useTranslation } from 'react-i18next';

interface ResourceSummaryBarProps {
  selectedModels: CuratedModel[];
  installedCatalogIds: string[];
  /** Available disk space in MB — the bar tracks new download size only. */
  availableStorageMb: number;
  availableMemoryMb: number;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export const ResourceSummaryBar = ({ selectedModels, installedCatalogIds, availableStorageMb, availableMemoryMb }: ResourceSummaryBarProps) => {
  const { t } = useTranslation();
  const budget = computeSelectionBudget(selectedModels, installedCatalogIds, availableStorageMb, availableMemoryMb);
  const diskPercent = availableStorageMb > 0 ? Math.min(100, Math.round((budget.downloadDiskMb / availableStorageMb) * 100)) : 0;
  const memoryPercent =
    availableMemoryMb > 0 ? Math.min(100, Math.round((budget.newMemoryMb / availableMemoryMb) * 100)) : budget.newMemoryMb > 0 ? 100 : 0;

  if (selectedModels.length === 0) return null;

  const memorySummary =
    budget.newMemoryMb > 0
      ? t('ONBOARDING_RESOURCE_NEW_SELECTIONS_MEMORY', {
          selected: formatSize(budget.newMemoryMb),
          available: formatSize(availableMemoryMb),
        })
      : budget.installedMemoryMb > 0
        ? t('ONBOARDING_RESOURCE_ALREADY_INSTALLED_MEMORY', { installed: formatSize(budget.installedMemoryMb) })
        : t('ONBOARDING_RESOURCE_MEMORY_AVAILABLE', {
            total: formatSize(budget.totalMemoryMb),
            available: formatSize(availableMemoryMb),
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
          <span className={budget.overMemory ? 'text-destructive font-medium' : 'text-muted-foreground'}>{memorySummary}</span>
        </div>
        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-1.5 rounded-full transition-all duration-300 ${budget.overMemory ? 'bg-destructive' : 'bg-secondary'}`}
            style={{ width: `${memoryPercent}%` }}
          />
        </div>
      </div>

      {budget.memoryNote && (
        <p className="text-xs text-muted-foreground" data-testid="resource-memory-note">
          {budget.memoryNote}
        </p>
      )}

      {budget.memoryWarning && (
        <p className="text-xs text-yellow-700 dark:text-yellow-500" data-testid="resource-memory-warning">
          {budget.memoryWarning}
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
