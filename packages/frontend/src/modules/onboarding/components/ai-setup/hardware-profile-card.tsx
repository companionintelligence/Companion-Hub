import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { AlertTriangle } from 'lucide-react';
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
  const noGpu = !hardware.gpu.available;
  const gpuNoRuntime = hardware.gpu.available && !hardware.gpu.runtimeAvailable;
  const gpuDriverGuidance = hardware.gpu.vendor === 'nvidia' ? 'NVIDIA CUDA' : hardware.gpu.vendor === 'amd' ? 'AMD ROCm' : null;

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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm mb-3">
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

        {/* Warning message when GPU is missing or runtime unavailable */}
        {(noGpu || gpuNoRuntime) && (
          <div className="flex items-start gap-2 p-2.5 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-md">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-yellow-800 dark:text-yellow-200">
              {noGpu && (
                <span>
                  <strong>No GPU detected.</strong> AI services will run on CPU only. Performance may be slower. Consider installing a graphics card
                  for better performance.
                </span>
              )}
              {gpuNoRuntime && (
                <span>
                  <strong>GPU driver not available.</strong> Your {hardware.gpu.vendor} GPU was detected but the runtime is not available. Please
                  install the appropriate drivers{gpuDriverGuidance ? ` (${gpuDriverGuidance})` : ''}.
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
