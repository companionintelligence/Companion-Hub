import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import { formatMemoryMb, resolveGpuSubLabel, resolveTierBadge, resolveVramDisplay } from '@/modules/onboarding/helpers/hardware-display';
import { RocmSetupCard } from '@/modules/onboarding/components/ai-setup/rocm-setup-card';
import { AlertTriangle, Cpu, HardDrive, MemoryStick, Monitor } from 'lucide-react';
import type { ReactNode } from 'react';
import { GpuIcon, VramIcon } from './icons';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';

interface SystemOverviewProps {
  hardware: HardwareProfile;
  tier: HardwareTier;
  onRescan: () => Promise<void>;
  rescanning?: boolean;
  availableDiskMb?: number;
  diskTotalMb?: number;
}

function getClientPlatform(): { label: string; arch: string } {
  if (typeof navigator === 'undefined') return { label: i18next.t('COMMON_UNKNOWN'), arch: '' };
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (platform.includes('win')) return { label: 'Windows', arch: '64-bit' };
  if (platform.includes('mac')) return { label: 'macOS', arch: '64-bit' };
  if (platform.includes('linux') || platform.includes('x11')) return { label: 'Linux', arch: '64-bit' };
  return { label: i18next.t('COMMON_UNKNOWN'), arch: '' };
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
 * System overview strip (OS / CPU / RAM / GPU / VRAM / Storage) plus host GPU guidance where relevant.
 *
 * Note: the hardware profile is the Hub's. OS shows the host OS/codename from the profile when
 * available (falling back to the connecting client), and storage total/free come from the profile's
 * resource estimate.
 */
export const SystemOverview = ({ hardware, tier, onRescan, rescanning = false, availableDiskMb, diskTotalMb }: SystemOverviewProps) => {
  const { t } = useTranslation();
  const badge = resolveTierBadge(tier, hardware);
  const vramDisplay = resolveVramDisplay(hardware);
  const os = getClientPlatform();
  const noGpu = !hardware.gpu.available;
  const showRocmSetup = hardware.gpu.available && hardware.gpu.vendor === 'amd';
  const nvidiaRuntimeMissing = hardware.gpu.vendor === 'nvidia' && !hardware.gpu.runtimeAvailable;
  const nvidiaRuntimeReady = hardware.gpu.vendor === 'nvidia' && hardware.gpu.runtimeAvailable;
  // A native Docker Engine inside WSL2 needs the same in-distro toolkit as native
  // Linux — not Docker Desktop's automatic WSL2 GPU integration. Show the Linux-style
  // steps for both, so a Windows WSL2-engine user is never told to "open Docker Desktop".
  const isWslEngineHost = hardware.gpu.containerHostKind === 'wsl-engine';
  const showLinuxRuntimeSteps = isLinuxClient() || isWslEngineHost;
  const ready = tier !== 'insufficient';

  return (
    <section className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Monitor className="h-6 w-6 text-primary" />
          <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg" data-testid="hw-card-title">
            {t('ONBOARDING_SYSTEM_OVERVIEW_TITLE')}
          </h2>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {ready ? t('ONBOARDING_SYSTEM_OVERVIEW_READY') : t('ONBOARDING_SYSTEM_OVERVIEW_INSUFFICIENT')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', badge.color)} data-testid="tier-badge">
            {badge.emoji} {badge.label}
          </span>
          <Button variant="outline" size="sm" onClick={onRescan} loading={rescanning} data-testid="rescan-btn">
            {t('ONBOARDING_RESCAN')}
          </Button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-border pt-5 sm:grid-cols-3 lg:grid-cols-6">
        <OverviewItem
          icon={<Monitor />}
          label={t('ONBOARDING_OS')}
          value={hardware.os?.name || os.label}
          sub={hardware.os?.version || os.arch}
          testId="hw-os"
        />
        <OverviewItem
          icon={<Cpu />}
          label={t('COMMON_CPU')}
          value={hardware.cpu.model}
          sub={`${hardware.cpu.cores} ${t('COMMON_CORES')} · ${hardware.cpu.arch}`}
          testId="hw-cpu"
        />
        <OverviewItem
          icon={<MemoryStick />}
          label={t('ONBOARDING_RAM')}
          value={formatMemoryMb(hardware.ram.totalMb)}
          sub={`${formatMemoryMb(hardware.ram.availableMb)} ${t('ONBOARDING_FREE')}`}
          testId="hw-ram"
        />
        <OverviewItem
          icon={<GpuIcon />}
          label={t('ONBOARDING_GPU')}
          value={hardware.gpu.available ? hardware.gpu.model : t('ONBOARDING_NO_GPU_DETECTED')}
          sub={resolveGpuSubLabel(hardware)}
          testId="hw-gpu"
        />
        <OverviewItem icon={<VramIcon />} label={t('ONBOARDING_VRAM')} value={vramDisplay.value} sub={vramDisplay.sub} />
        <OverviewItem
          icon={<HardDrive />}
          label={t('ONBOARDING_STORAGE')}
          value={diskTotalMb ? formatMemoryMb(diskTotalMb) : t('COMMON_DASH')}
          sub={availableDiskMb ? `${formatMemoryMb(availableDiskMb)} ${t('ONBOARDING_FREE')}` : undefined}
        />
      </div>

      {noGpu && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2.5 dark:border-yellow-800 dark:bg-yellow-950">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
          <div className="text-xs text-yellow-800 dark:text-yellow-200">
            <strong>{t('ONBOARDING_NO_GPU_DETECTED_STRONG')}</strong> {t('ONBOARDING_NO_GPU_DETECTED_DESC')}
          </div>
        </div>
      )}

      {showRocmSetup && <RocmSetupCard hardware={hardware} onRescan={onRescan} rescanning={rescanning} />}

      {nvidiaRuntimeMissing && (
        <div
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="nvidia-runtime-warning"
        >
          <p className="mb-2">{t('ONBOARDING_NVIDIA_RUNTIME_MISSING_DESC_1')}</p>
          <p className="mb-2">{t('ONBOARDING_NVIDIA_RUNTIME_MISSING_DESC_2')}</p>
          <p className="font-semibold">{t('ONBOARDING_ACTION_ITEMS')}</p>
          <div className="mt-2 space-y-3 leading-relaxed">
            <div>
              <p className="font-semibold">1. {t('ONBOARDING_RETRY_AUTOMATIC_SETUP')}</p>
              <p>{t('ONBOARDING_RETRY_AUTOMATIC_SETUP_DESC')}</p>
            </div>
            <div>
              {showLinuxRuntimeSteps ? (
                <>
                  <p className="font-semibold">2. {t('ONBOARDING_MANUAL_INSTALL_DISTRO_SPECIFIC')}</p>
                  {isWslEngineHost && <p className="mt-1 text-amber-800 dark:text-amber-200/90">{t('ONBOARDING_WSL_ENGINE_MANUAL_NOTE')}</p>}
                  <div className="mt-1.5 space-y-2">
                    <div className="rounded bg-amber-100/70 p-2.5 font-mono text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                      <p className="font-semibold text-amber-950 dark:text-amber-100">{t('ONBOARDING_DISTRO_DEBIAN_UBUNTU')}</p>
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
                      <p className="font-semibold text-amber-950 dark:text-amber-100">{t('ONBOARDING_DISTRO_RHEL_FEDORA')}</p>
                      <p>
                        curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee
                        /etc/yum.repos.d/nvidia-container-toolkit.repo
                      </p>
                      <p>sudo dnf install -y nvidia-container-toolkit</p>
                    </div>
                    <div className="rounded bg-amber-100/70 p-2.5 font-mono text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                      <p className="font-semibold text-amber-950 dark:text-amber-100">{t('ONBOARDING_DISTRO_ARCH_MANJARO')}</p>
                      <p>sudo pacman -Sy --noconfirm nvidia-container-toolkit</p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="font-semibold">2. {t('ONBOARDING_COMPLETE_GPU_SUPPORT_HOST')}</p>
                  <div className="mt-1.5 rounded bg-amber-100/70 p-2.5 text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                    {t('ONBOARDING_COMPLETE_GPU_SUPPORT_HOST_DESC')}
                  </div>
                </>
              )}
            </div>
            {showLinuxRuntimeSteps && (
              <div>
                <p className="font-semibold">3. {t('ONBOARDING_THEN_RUN')}</p>
                <div className="mt-1.5 rounded bg-amber-100/70 p-2.5 font-mono text-[11px] leading-6 text-amber-950 dark:bg-black/30 dark:text-amber-100/90">
                  <p>sudo nvidia-ctk runtime configure --runtime=docker</p>
                  <p>sudo systemctl restart docker</p>
                  <p>docker info | grep -i nvidia</p>
                </div>
              </div>
            )}
            <div>
              <p>
                {showLinuxRuntimeSteps ? '4.' : '3.'} {t('ONBOARDING_RETURN_AND_CLICK')}{' '}
                <span className="font-semibold">{t('ONBOARDING_RESCAN')}</span>.
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
          {t('ONBOARDING_NVIDIA_RUNTIME_READY')}
        </div>
      )}
    </section>
  );
};
