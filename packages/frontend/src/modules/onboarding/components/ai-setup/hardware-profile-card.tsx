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
  const nvidiaRuntimeMissing = hardware.gpu.vendor === 'nvidia' && !hardware.gpu.runtimeAvailable;
  const nvidiaRuntimeReady = hardware.gpu.vendor === 'nvidia' && hardware.gpu.runtimeAvailable;

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

        {nvidiaRuntimeMissing && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100" data-testid="nvidia-runtime-warning">
            <p className="mb-2">
              NVIDIA GPU detected, but GPU runtime is not ready yet. AI inference will run in CPU-only mode until setup completes.
            </p>
            <p className="mb-2">
              Automatic setup runs during startup in non-interactive mode. If your system requires a sudo password prompt, the automatic install is
              skipped.
            </p>
            <p className="font-semibold">Action items:</p>
            <ol className="mt-1 list-decimal pl-4 space-y-1">
              <li>Close and reopen CI Hub to retry automatic GPU setup.</li>
              <li>
                If runtime is still missing, run a manual install:
                <div className="mt-1 rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-amber-100/90">
                  Debian/Ubuntu:
                  <br />
                  sudo mkdir -p /etc/apt/keyrings
                  <br />
                  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o
                  /etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg
                  <br />
                  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb
                  [signed-by=/etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee
                  /etc/apt/sources.list.d/nvidia-container-toolkit.list
                  <br />
                  sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
                  <br />
                  RHEL/Fedora:
                  <br />
                  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee
                  /etc/yum.repos.d/nvidia-container-toolkit.repo
                  <br />
                  sudo dnf install -y nvidia-container-toolkit
                  <br />
                  Arch/Manjaro: sudo pacman -Sy --noconfirm nvidia-container-toolkit
                  <br />
                  Then: sudo nvidia-ctk runtime configure --runtime=docker
                  <br />
                  Then: sudo systemctl restart docker
                  <br />
                  Verify: docker info | grep -i nvidia
                </div>
              </li>
              <li>
                Return here and click <span className="font-semibold">Rescan</span>.
              </li>
            </ol>
          </div>
        )}

        {nvidiaRuntimeReady && (
          <div
            className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-100"
            data-testid="nvidia-runtime-ready"
          >
            NVIDIA GPU detected and NVIDIA container runtime is configured. AI inference can use GPU acceleration.
          </div>
        )}
      </CardContent>
    </Card>
  );
};
