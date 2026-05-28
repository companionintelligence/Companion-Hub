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

function getClientPlatform(): 'linux' | 'windows' | 'macos' | 'other' {
  if (typeof navigator === 'undefined') return 'other';

  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('linux') || platform.includes('x11')) return 'linux';
  return 'other';
}

export const HardwareProfileCard = ({ hardware, tier, onRescan, rescanning = false }: HardwareProfileCardProps) => {
  const badge = TIER_BADGES[tier];
  const noGpu = !hardware.gpu.available;
  const amdRuntimeMissing = hardware.gpu.vendor === 'amd' && hardware.gpu.available && !hardware.gpu.runtimeAvailable;
  const amdDriverGuidance = 'AMD ROCm';
  const nvidiaRuntimeMissing = hardware.gpu.vendor === 'nvidia' && !hardware.gpu.runtimeAvailable;
  const nvidiaRuntimeReady = hardware.gpu.vendor === 'nvidia' && hardware.gpu.runtimeAvailable;
  const clientPlatform = getClientPlatform();
  const showLinuxRuntimeSteps = clientPlatform === 'linux';

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

        {noGpu && (
          <div className="flex items-start gap-2 p-2.5 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-md">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-yellow-800 dark:text-yellow-200">
              <strong>No GPU detected.</strong> AI services will run on CPU only. Performance may be slower. Consider installing a graphics card for
              better performance.
            </div>
          </div>
        )}

        {amdRuntimeMissing && (
          <div className="flex items-start gap-2 p-2.5 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-md">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-yellow-800 dark:text-yellow-200">
              <strong>GPU driver not available.</strong> Your {hardware.gpu.vendor} GPU was detected but the runtime is not available. Please install
              the appropriate drivers ({amdDriverGuidance}).
            </div>
          </div>
        )}

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
            <div className="mt-2 space-y-3 leading-relaxed">
              <div>
                <p className="font-semibold">1. Retry automatic setup</p>
                <p>Close and reopen CI Hub to retry automatic GPU setup.</p>
              </div>

              <div>
                {showLinuxRuntimeSteps ? (
                  <>
                    <p className="font-semibold">2. Manual install (distribution-specific)</p>
                    <div className="mt-1.5 space-y-2">
                      <div className="rounded bg-black/30 p-2.5 font-mono text-[11px] leading-6 text-amber-100/90">
                        <p className="font-semibold text-amber-100">Debian/Ubuntu</p>
                        <p>sudo mkdir -p /etc/apt/keyrings</p>
                        <p>
                          curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o
                          /etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg
                        </p>
                        <p>
                          curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb
                          [signed-by=/etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee
                          /etc/apt/sources.list.d/nvidia-container-toolkit.list
                        </p>
                        <p>sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit</p>
                      </div>

                      <div className="rounded bg-black/30 p-2.5 font-mono text-[11px] leading-6 text-amber-100/90">
                        <p className="font-semibold text-amber-100">RHEL/Fedora</p>
                        <p>
                          curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee
                          /etc/yum.repos.d/nvidia-container-toolkit.repo
                        </p>
                        <p>sudo dnf install -y nvidia-container-toolkit</p>
                      </div>

                      <div className="rounded bg-black/30 p-2.5 font-mono text-[11px] leading-6 text-amber-100/90">
                        <p className="font-semibold text-amber-100">Arch/Manjaro</p>
                        <p>sudo pacman -Sy --noconfirm nvidia-container-toolkit</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="font-semibold">2. Complete GPU support in your host environment</p>
                    <div className="mt-1.5 rounded bg-black/30 p-2.5 text-[11px] leading-6 text-amber-100/90">
                      On Windows, open Docker Desktop and confirm WSL2 GPU support is enabled. On other non-Linux hosts, verify your Docker setup and
                      NVIDIA drivers support GPU passthrough for containers before rescanning.
                    </div>
                  </>
                )}
              </div>

              {showLinuxRuntimeSteps && (
                <div>
                  <p className="font-semibold">3. Then run (same on all distributions)</p>
                  <div className="mt-1.5 rounded bg-black/30 p-2.5 font-mono text-[11px] leading-6 text-amber-100/90">
                    <p>sudo nvidia-ctk runtime configure --runtime=docker</p>
                    <p>sudo systemctl restart docker</p>
                    <p>docker info | grep -i nvidia</p>
                  </div>
                </div>
              )}

              <div>
                <p>
                  {showLinuxRuntimeSteps ? '4.' : '3.'} Return here and click <span className="font-semibold">Rescan</span>.
                </p>
              </div>
            </div>
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
