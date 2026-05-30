import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import { AlertTriangle, Cpu, HardDrive, MemoryStick, Monitor } from 'lucide-react';
import type { ReactNode } from 'react';
import { GpuIcon, VramIcon } from './icons';

interface SystemOverviewProps {
  hardware: HardwareProfile;
  tier: HardwareTier;
  onRescan: () => Promise<void>;
  rescanning?: boolean;
}

const TIER_BADGES: Record<HardwareTier, { label: string; color: string; emoji: string }> = {
  high: { label: 'High', color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', emoji: '🚀' },
  medium: { label: 'Medium', color: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', emoji: '⚡' },
  low: { label: 'Low', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200', emoji: '💡' },
  'cpu-only': { label: 'CPU Only', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200', emoji: '🔧' },
  insufficient: { label: 'Insufficient', color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200', emoji: '☁️' },
};

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function getClientPlatform(): { label: string; arch: string } {
  if (typeof navigator === 'undefined') return { label: 'Unknown', arch: '' };
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (platform.includes('win')) return { label: 'Windows', arch: '64-bit' };
  if (platform.includes('mac')) return { label: 'macOS', arch: '64-bit' };
  if (platform.includes('linux') || platform.includes('x11')) return { label: 'Linux', arch: '64-bit' };
  return { label: 'Unknown', arch: '' };
}

function isLinuxClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  return platform.includes('linux') || platform.includes('x11');
}

function OverviewItem({ icon, label, value, sub, testId }: { icon: ReactNode; label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="flex items-start gap-3" data-testid={testId}>
      <span className="mt-0.5 text-primary [&_svg]:h-6 [&_svg]:w-6">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-medium" title={value}>
          {value}
        </div>
        {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

/**
 * System overview strip (OS / CPU / RAM / GPU / VRAM / Storage) plus the GPU container-runtime
 * guidance that gates accelerated inference. Replaces the old "Hardware Detected" card visually but
 * keeps all of its detection warnings.
 *
 * Note: the hardware profile is the Hub's; OS is derived from the connecting client and total
 * storage isn't reported by the profile API yet, so it shows "—".
 */
export const SystemOverview = ({ hardware, tier, onRescan, rescanning = false }: SystemOverviewProps) => {
  const badge = TIER_BADGES[tier];
  const os = getClientPlatform();
  const noGpu = !hardware.gpu.available;
  const amdRuntimeMissing = hardware.gpu.vendor === 'amd' && hardware.gpu.available && !hardware.gpu.runtimeAvailable;
  const nvidiaRuntimeMissing = hardware.gpu.vendor === 'nvidia' && !hardware.gpu.runtimeAvailable;
  const nvidiaRuntimeReady = hardware.gpu.vendor === 'nvidia' && hardware.gpu.runtimeAvailable;
  const showLinuxRuntimeSteps = isLinuxClient();
  const ready = tier !== 'insufficient';

  return (
    <section className="rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Monitor className="h-6 w-6 text-primary" />
          <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg" data-testid="hw-card-title">
            System Overview
          </h2>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {ready ? 'Your machine is ready to run local models.' : "Your hardware can't run local models — add a cloud provider below."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', badge.color)} data-testid="tier-badge">
            {badge.emoji} {badge.label}
          </span>
          <Button variant="ghost" size="sm" onClick={onRescan} loading={rescanning} data-testid="rescan-btn">
            Rescan
          </Button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-border pt-5 sm:grid-cols-3 lg:grid-cols-6">
        <OverviewItem icon={<Monitor />} label="OS" value={os.label} sub={os.arch} />
        <OverviewItem
          icon={<Cpu />}
          label="CPU"
          value={hardware.cpu.model}
          sub={`${hardware.cpu.cores} cores · ${hardware.cpu.arch}`}
          testId="hw-cpu"
        />
        <OverviewItem
          icon={<MemoryStick />}
          label="RAM"
          value={formatMemory(hardware.ram.totalMb)}
          sub={`${formatMemory(hardware.ram.availableMb)} free`}
          testId="hw-ram"
        />
        <OverviewItem
          icon={<GpuIcon />}
          label="GPU"
          value={hardware.gpu.available ? hardware.gpu.model : 'No GPU detected'}
          sub={hardware.gpu.available ? hardware.gpu.vendor.toUpperCase() : undefined}
          testId="hw-gpu"
        />
        <OverviewItem
          icon={<VramIcon />}
          label="VRAM"
          value={hardware.gpu.available ? (hardware.gpu.unifiedMemory ? 'Unified' : formatMemory(hardware.gpu.vramMb)) : '—'}
          sub={hardware.gpu.unifiedMemory ? 'Unified Memory' : undefined}
        />
        <OverviewItem icon={<HardDrive />} label="Storage" value="—" />
      </div>

      {noGpu && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2.5 dark:border-yellow-800 dark:bg-yellow-950">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
          <div className="text-xs text-yellow-800 dark:text-yellow-200">
            <strong>No GPU detected.</strong> AI services will run on CPU only. Performance may be slower. Consider installing a graphics card for
            better performance.
          </div>
        </div>
      )}

      {amdRuntimeMissing && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2.5 dark:border-yellow-800 dark:bg-yellow-950">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
          <div className="text-xs text-yellow-800 dark:text-yellow-200">
            <strong>Container GPU runtime not available.</strong> Your {hardware.gpu.vendor} GPU was detected, but containerized backends do not have
            ROCm access yet. Host-side Ollama can still use the GPU once it is installed and reachable. Please install the appropriate drivers (AMD
            ROCm) to enable container GPU acceleration too.
          </div>
        </div>
      )}

      {nvidiaRuntimeMissing && (
        <div
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="nvidia-runtime-warning"
        >
          <p className="mb-2">
            NVIDIA GPU detected, but the container GPU runtime is not ready yet. Host-side Ollama can still use this GPU, but containerized backends
            like vLLM need the NVIDIA container runtime before they can accelerate.
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
                    <div className="rounded bg-amber-100/70 p-2.5 font-mono text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                      <p className="font-semibold text-amber-950 dark:text-amber-100">Debian/Ubuntu</p>
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
                    <div className="rounded bg-amber-100/70 p-2.5 font-mono text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                      <p className="font-semibold text-amber-950 dark:text-amber-100">RHEL/Fedora</p>
                      <p>
                        curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee
                        /etc/yum.repos.d/nvidia-container-toolkit.repo
                      </p>
                      <p>sudo dnf install -y nvidia-container-toolkit</p>
                    </div>
                    <div className="rounded bg-amber-100/70 p-2.5 font-mono text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                      <p className="font-semibold text-amber-950 dark:text-amber-100">Arch/Manjaro</p>
                      <p>sudo pacman -Sy --noconfirm nvidia-container-toolkit</p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="font-semibold">2. Complete GPU support in your host environment</p>
                  <div className="mt-1.5 rounded bg-amber-100/70 p-2.5 text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                    On Windows, open Docker Desktop and confirm WSL2 GPU support is enabled. On other non-Linux hosts, verify your Docker setup and
                    NVIDIA drivers support GPU passthrough for containers before rescanning.
                  </div>
                </>
              )}
            </div>
            {showLinuxRuntimeSteps && (
              <div>
                <p className="font-semibold">3. Then run (same on all distributions)</p>
                <div className="mt-1.5 rounded bg-amber-100/70 p-2.5 font-mono text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
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
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
          data-testid="nvidia-runtime-ready"
        >
          NVIDIA GPU detected and NVIDIA container runtime is configured. AI inference can use GPU acceleration.
        </div>
      )}
    </section>
  );
};
