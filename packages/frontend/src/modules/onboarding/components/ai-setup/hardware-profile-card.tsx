import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';

interface HardwareProfileCardProps {
  hardware: HardwareProfile;
  tier: HardwareTier;
  onRescan: () => Promise<void>;
  rescanning?: boolean;
}

const TIER_BADGES: Record<HardwareTier, { label: string; color: string; emoji: string }> = {
  high: { label: 'High', color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', emoji: '🚀' },
  medium: { label: 'Medium', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200', emoji: '⚡' },
  low: { label: 'Low', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200', emoji: '💡' },
  'cpu-only': { label: 'CPU Only', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200', emoji: '🔧' },
  insufficient: { label: 'Insufficient', color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200', emoji: '☁️' },
};

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export const HardwareProfileCard = ({ hardware, tier, onRescan, rescanning = false }: HardwareProfileCardProps) => {
  const badge = TIER_BADGES[tier];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" data-testid="hw-card-title">
            Hardware Detected
          </h3>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.color}`} data-testid="tier-badge">
              {badge.emoji} {badge.label}
            </span>
            <Button variant="ghost" size="sm" onClick={onRescan} loading={rescanning} data-testid="rescan-btn">
              Rescan
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div data-testid="hw-gpu">
            <div className="text-muted-foreground text-xs">GPU</div>
            <div className="font-medium">{hardware.gpu.available ? `${hardware.gpu.model}` : 'No GPU detected'}</div>
            {hardware.gpu.available && (
              <div className="text-xs text-muted-foreground">
                {hardware.gpu.unifiedMemory ? 'Unified Memory' : formatMemory(hardware.gpu.vramMb)} VRAM
              </div>
            )}
          </div>

          <div data-testid="hw-ram">
            <div className="text-muted-foreground text-xs">RAM</div>
            <div className="font-medium">{formatMemory(hardware.ram.totalMb)}</div>
            <div className="text-xs text-muted-foreground">{formatMemory(hardware.ram.availableMb)} available</div>
          </div>

          <div data-testid="hw-cpu">
            <div className="text-muted-foreground text-xs">CPU</div>
            <div className="font-medium">{hardware.cpu.model}</div>
            <div className="text-xs text-muted-foreground">
              {hardware.cpu.cores} cores · {hardware.cpu.arch}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
