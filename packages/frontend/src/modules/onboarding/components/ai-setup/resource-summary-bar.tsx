import type { CuratedModel } from '@ci-hub/common/types';

interface ResourceSummaryBarProps {
  selectedModels: CuratedModel[];
  availableMemoryMb: number;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export const ResourceSummaryBar = ({ selectedModels, availableMemoryMb }: ResourceSummaryBarProps) => {
  const totalMemoryMb = selectedModels.reduce((sum, m) => sum + m.runtime.memoryFootprintMb, 0);
  const overBudget = totalMemoryMb > availableMemoryMb;
  const percent = availableMemoryMb > 0 ? Math.min(100, Math.round((totalMemoryMb / availableMemoryMb) * 100)) : 0;

  if (selectedModels.length === 0) return null;

  return (
    <div className="rounded-lg border p-3" data-testid="resource-summary">
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="font-medium">
          {selectedModels.length} model{selectedModels.length === 1 ? '' : 's'} selected
        </span>
        <span className={overBudget ? 'text-destructive font-medium' : 'text-muted-foreground'}>
          {formatSize(totalMemoryMb)} / {formatSize(availableMemoryMb)} available
        </span>
      </div>

      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
        <div
          className={`h-1.5 rounded-full transition-all duration-300 ${overBudget ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {overBudget && (
        <p className="text-xs text-destructive mt-1.5" data-testid="resource-warning">
          Selected models exceed available memory. Consider deselecting some models or adding a cloud provider as fallback.
        </p>
      )}
    </div>
  );
};
