import { Button } from '@/components/ui/Button';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { probeHealthyHubApiPort } from '@/lib/tauri-hub-probe';
import { cn } from '@/lib/utils';
import { TranslatableError } from '@/types/error.types';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import { formatMemoryMb, resolveGpuSubLabel, resolveTierBadge, resolveVramDisplay } from '@/modules/onboarding/helpers/hardware-display';
import { RocmSetupCard } from '@/modules/onboarding/components/ai-setup/rocm-setup-card';
import { AlertTriangle, ChevronDown, ChevronUp, Cpu, HardDrive, MemoryStick, Monitor } from 'lucide-react';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { type ReactNode, useRef, useState } from 'react';
import { AutoInstallRunnerButton } from './auto-install-runner-button';
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
        <div className="text-[11px] font-medium   text-muted-foreground">{label}</div>
        {/*
          Wrap to a second line rather than hard-truncating: at six columns these
          tiles clipped their own values ("No GPU detect…", "12 cores · ar…"),
          which reads as the app failing to fit its own data.
        */}
        <div className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]" title={value}>
          {value}
        </div>
        {sub && (
          <div className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={sub}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Docker's restart takes the Hub down too, so the rescan waits until the Hub answers again. Three
 * minutes, the time the desktop app gives the Hub to turn healthy when it starts the stack.
 */
const RUNTIME_RESCAN_ATTEMPTS = 36;
const RUNTIME_RESCAN_DELAY_MS = 5_000;

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
  // Docker lists the nvidia runtime as soon as the toolkit is installed, with or without a driver,
  // so "ready" also needs the host's own proof that the driver answers.
  const nvidiaDriverMissing = hardware.gpu.vendor === 'nvidia' && hardware.gpu.hostNvidiaAvailable === false && !hardware.gpu.driverVersion;
  const nvidiaRuntimeMissing = hardware.gpu.vendor === 'nvidia' && !hardware.gpu.runtimeAvailable && !nvidiaDriverMissing;
  const nvidiaRuntimeReady = hardware.gpu.vendor === 'nvidia' && hardware.gpu.runtimeAvailable && !nvidiaDriverMissing;
  // Only `cihub up` and the Windows desktop app set the runtime up at startup. The Linux desktop
  // app offers a button instead, so it doesn't promise a retry on reopening.
  const desktopInstallsRuntime = isTauriDesktopApp() && hardware.gpu.containerHostKind === 'native-linux';
  // A native Docker Engine inside WSL2 needs the same in-distro toolkit as native
  // Linux — not Docker Desktop's automatic WSL2 GPU integration. Show the Linux-style
  // steps for both, so a Windows WSL2-engine user is never told to "open Docker Desktop".
  const isWslEngineHost = hardware.gpu.containerHostKind === 'wsl-engine';
  const showLinuxRuntimeSteps = isLinuxClient() || isWslEngineHost;
  // On WSL2 the driver belongs to Windows. A Linux driver installed in the distro breaks GPU access.
  const showUbuntuDriverCommand = isLinuxClient() && !isWslEngineHost;
  // The install can take minutes. A rescan from the render that started it would restore the engine picked back then.
  const latestOnRescan = useRef(onRescan);
  latestOnRescan.current = onRescan;
  // The distribution commands are long. Folded away as on the ROCm card, they no longer push the page below the fold.
  const [manualOpen, setManualOpen] = useState(false);

  const installRuntime = async () => {
    await getTauriInvoke()?.('install_nvidia_runtime_command');
    // A rescan that fails replaces this step with an error page, so wait for the Hub to answer first.
    for (let attempt = 0; attempt < RUNTIME_RESCAN_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, RUNTIME_RESCAN_DELAY_MS));
      if ((await probeHealthyHubApiPort()) !== null) {
        await latestOnRescan.current();
        return;
      }
    }
    throw new TranslatableError('ONBOARDING_NVIDIA_RUNTIME_HUB_NOT_BACK');
  };

  const rescanButton = (
    <Button variant="outline" size="sm" onClick={onRescan} loading={rescanning} data-testid="nvidia-rescan-btn">
      {t('ONBOARDING_RESCAN')}
    </Button>
  );

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Monitor className="h-6 w-6 text-primary" />
          <h2 className="text-base font-medium   sm:text-lg" data-testid="hw-card-title">
            {t('ONBOARDING_SYSTEM_OVERVIEW_TITLE')}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground" data-testid="tier-badge">
            <span className={cn('size-2 rounded-full', badge.dot)} aria-hidden />
            {badge.label}
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

      {/* The Hub's warning Alert: the icon and heading in the warning colour, the text in the page's own
          colours, and commands in the muted blocks the ROCm card uses. role="note" because it is
          guidance, not news; the install's own error keeps role="alert". */}
      {noGpu && (
        <Alert variant="warning" role="note" className="mt-4">
          <AlertIcon>
            <AlertTriangle strokeWidth={2} />
          </AlertIcon>
          <AlertDescription className="text-xs">
            <strong>{t('ONBOARDING_NO_GPU_DETECTED_STRONG')}</strong> {t('ONBOARDING_NO_GPU_DETECTED_DESC')}
          </AlertDescription>
        </Alert>
      )}

      {showRocmSetup && <RocmSetupCard hardware={hardware} onRescan={onRescan} rescanning={rescanning} />}

      {nvidiaDriverMissing && (
        <Alert variant="warning" role="note" className="mt-4" data-testid="nvidia-driver-warning">
          <AlertIcon>
            <AlertTriangle strokeWidth={2} />
          </AlertIcon>
          <div className="min-w-0 space-y-3 text-xs">
            <AlertHeading>{t('ONBOARDING_NVIDIA_DRIVER_MISSING_TITLE')}</AlertHeading>
            <AlertDescription>{t('ONBOARDING_NVIDIA_DRIVER_MISSING_DESC')}</AlertDescription>
            {showUbuntuDriverCommand && (
              <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                <p className="font-medium font-sans">{t('ONBOARDING_DISTRO_UBUNTU')}</p>
                <p>sudo ubuntu-drivers install</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {/* Only the desktop app and `cihub up` write the probe that proves the driver. A Rescan alone only reads it. */}
              <span>{t(isTauriDesktopApp() ? 'ONBOARDING_NVIDIA_DRIVER_THEN_RESCAN' : 'ONBOARDING_NVIDIA_DRIVER_THEN_CIHUB_UP_RESCAN')}</span>
              {rescanButton}
            </div>
          </div>
        </Alert>
      )}

      {nvidiaRuntimeMissing && (
        <Alert variant="warning" role="note" className="mt-4" data-testid="nvidia-runtime-warning">
          <AlertIcon>
            <AlertTriangle strokeWidth={2} />
          </AlertIcon>
          <div className="min-w-0 space-y-3 text-xs leading-relaxed">
            <AlertHeading>{t('ONBOARDING_NVIDIA_RUNTIME_MISSING_TITLE')}</AlertHeading>
            {/* One description, so both paragraphs take the muted colour the Alert gives the text under a heading. */}
            <AlertDescription className="space-y-2">
              <p>{t('ONBOARDING_NVIDIA_RUNTIME_MISSING_DESC_1')}</p>
              {!desktopInstallsRuntime && <p>{t('ONBOARDING_NVIDIA_RUNTIME_MISSING_DESC_2')}</p>}
            </AlertDescription>
            <p className="font-medium">{t('ONBOARDING_ACTION_ITEMS')}</p>
            {desktopInstallsRuntime ? (
              <div>
                <p className="mb-1.5 font-medium">1. {t('ONBOARDING_NVIDIA_RUNTIME_RUN_AUTOMATICALLY')}</p>
                <AutoInstallRunnerButton
                  onRun={installRuntime}
                  labels={{
                    installing: t('ONBOARDING_NVIDIA_RUNTIME_INSTALLING'),
                    complete: t('ONBOARDING_NVIDIA_RUNTIME_INSTALLED'),
                    failed: t('ONBOARDING_NVIDIA_RUNTIME_INSTALL_ERROR'),
                  }}
                />
              </div>
            ) : (
              <div>
                <p className="font-medium">1. {t('ONBOARDING_RETRY_AUTOMATIC_SETUP')}</p>
                <p className="text-muted-foreground">{t('ONBOARDING_RETRY_AUTOMATIC_SETUP_DESC')}</p>
              </div>
            )}
            {showLinuxRuntimeSteps ? (
              <div>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium text-foreground"
                  onClick={() => setManualOpen((open) => !open)}
                  aria-expanded={manualOpen}
                  data-testid="nvidia-manual-toggle"
                >
                  2. {t('ONBOARDING_MANUAL_INSTALL_DISTRO_SPECIFIC')}
                  {manualOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {isWslEngineHost && <p className="mt-1 text-muted-foreground">{t('ONBOARDING_WSL_ENGINE_MANUAL_NOTE')}</p>}
                {manualOpen && (
                  <div className="mt-2 space-y-2">
                    <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                      <p className="font-medium font-sans">{t('ONBOARDING_DISTRO_DEBIAN_UBUNTU')}</p>
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
                    <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                      <p className="font-medium font-sans">{t('ONBOARDING_DISTRO_RHEL_FEDORA')}</p>
                      <p>
                        curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee
                        /etc/yum.repos.d/nvidia-container-toolkit.repo
                      </p>
                      <p>sudo dnf install -y nvidia-container-toolkit</p>
                    </div>
                    <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                      <p className="font-medium font-sans">{t('ONBOARDING_DISTRO_ARCH_MANJARO')}</p>
                      <p>sudo pacman -Sy --noconfirm nvidia-container-toolkit</p>
                    </div>
                    <p className="font-medium">{t('ONBOARDING_THEN_RUN')}</p>
                    <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                      <p>sudo nvidia-ctk runtime configure --runtime=docker</p>
                      <p>sudo systemctl restart docker</p>
                      <p>docker info | grep -i nvidia</p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <p className="font-medium">2. {t('ONBOARDING_COMPLETE_GPU_SUPPORT_HOST')}</p>
                <p className="mt-1 text-muted-foreground">{t('ONBOARDING_COMPLETE_GPU_SUPPORT_HOST_DESC')}</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <p>
                3. {t('ONBOARDING_RETURN_AND_CLICK')} <span className="font-medium">{t('ONBOARDING_RESCAN')}</span>.
              </p>
              {rescanButton}
            </div>
          </div>
        </Alert>
      )}

      {nvidiaRuntimeReady && (
        <Alert variant="success" role="note" className="mt-4" data-testid="nvidia-runtime-ready">
          <AlertDescription className="text-xs">{t('ONBOARDING_NVIDIA_RUNTIME_READY')}</AlertDescription>
        </Alert>
      )}
    </section>
  );
};
