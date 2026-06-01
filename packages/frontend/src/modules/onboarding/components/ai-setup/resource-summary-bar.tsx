import type { CuratedModel } from '@ci-hub/common/types';
import { computeSelectionBudget } from '../../helpers/onboarding-model-selection';

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
  const budget = computeSelectionBudget(selectedModels, installedCatalogIds, availableStorageMb, availableMemoryMb);
  const diskPercent = availableStorageMb > 0 ? Math.min(100, Math.round((budget.downloadDiskMb / availableStorageMb) * 100)) : 0;
  const memoryPercent = availableMemoryMb > 0 ? Math.min(100, Math.round((budget.totalMemoryMb / availableMemoryMb) * 100)) : 0;

  if (selectedModels.length === 0) return null;

  return (
    <div className="rounded-lg border p-3 space-y-3" data-testid="resource-summary">
      <div>
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="font-medium">
            {selectedModels.length} model{selectedModels.length === 1 ? '' : 's'} selected
          </span>
          <span className={budget.overDisk ? 'text-destructive font-medium' : 'text-muted-foreground'}>
            {formatSize(budget.downloadDiskMb)} to download / {formatSize(availableStorageMb)} disk available
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
          <span className="font-medium">Inference memory</span>
          <span className={budget.overMemory ? 'text-destructive font-medium' : 'text-muted-foreground'}>
            {formatSize(budget.totalMemoryMb)} / {formatSize(availableMemoryMb)} available
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-1.5 rounded-full transition-all duration-300 ${budget.overMemory ? 'bg-destructive' : 'bg-secondary'}`}
            style={{ width: `${memoryPercent}%` }}
          />
        </div>
      </div>

      {(budget.overDisk || budget.overMemory) && (
        <p className="text-xs text-destructive" data-testid="resource-warning">
          {budget.reason}
        </p>
      )}
    </div>
  );
};
