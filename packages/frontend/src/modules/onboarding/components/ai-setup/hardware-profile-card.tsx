import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import { ONBOARDING_HW_TIER_HINT, ONBOARDING_HW_UNIFIED_MEMORY_HINT } from '@/components/hub-status/hub-status-tooltips';
import { AlertTriangle } from 'lucide-react';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import { resolveAmdHostRocmNotice } from '@/modules/onboarding/helpers/hardware-display';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

interface HardwareProfileCardProps {
  hardware: HardwareProfile;
  tier: HardwareTier;
  onRescan: () => Promise<void>;
  rescanning?: boolean;
}

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
  const { t } = useTranslation();
  const tierBadges: Record<HardwareTier, { label: string; color: string; emoji: string }> = {
    high: { label: t('ONBOARDING_TIER_HIGH'), color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', emoji: '🚀' },
    medium: { label: t('ONBOARDING_TIER_MEDIUM'), color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200', emoji: '⚡' },
    low: { label: t('ONBOARDING_TIER_LOW'), color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200', emoji: '💡' },
    'cpu-only': { label: t('ONBOARDING_TIER_CPU_ONLY'), color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200', emoji: '🔧' },
    insufficient: {
      label: t('ONBOARDING_TIER_INSUFFICIENT'),
      color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
      emoji: '☁️',
    },
  };
  const badge = tierBadges[tier];
  const noGpu = !hardware.gpu.available;
  const amdHostRocm = resolveAmdHostRocmNotice(hardware);
  const nvidiaRuntimeMissing = hardware.gpu.vendor === 'nvidia' && !hardware.gpu.runtimeAvailable;
  const nvidiaRuntimeReady = hardware.gpu.vendor === 'nvidia' && hardware.gpu.runtimeAvailable;
  const clientPlatform = getClientPlatform();
  const showLinuxRuntimeSteps = clientPlatform === 'linux';

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" data-testid="hw-card-title">
            {t('ONBOARDING_HARDWARE_DETECTED')}
          </h3>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center ${badge.color}`} data-testid="tier-badge">
              {badge.emoji} <LabelWithHint label={badge.label} hint={ONBOARDING_HW_TIER_HINT} hintId="hw-tier" />
            </span>
            <Button variant="ghost" size="sm" onClick={onRescan} loading={rescanning} data-testid="rescan-btn">
              {t('ONBOARDING_RESCAN')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm mb-3">
          <div data-testid="hw-gpu">
            <div className="text-muted-foreground text-xs">{t('ONBOARDING_GPU')}</div>
            <div className="font-medium">{hardware.gpu.available ? `${hardware.gpu.model}` : t('ONBOARDING_NO_GPU_DETECTED')}</div>
            {hardware.gpu.available && (
              <div className="text-xs text-muted-foreground">
                {hardware.gpu.unifiedMemory ? (
                  <LabelWithHint label={t('ONBOARDING_UNIFIED_MEMORY')} hint={ONBOARDING_HW_UNIFIED_MEMORY_HINT} hintId="hw-unified-memory" />
                ) : (
                  `${formatMemory(hardware.gpu.vramMb)} ${t('ONBOARDING_VRAM')}`
                )}
              </div>
            )}
          </div>

          <div data-testid="hw-ram">
            <div className="text-muted-foreground text-xs">{t('ONBOARDING_RAM')}</div>
            <div className="font-medium">{formatMemory(hardware.ram.totalMb)}</div>
            <div className="text-xs text-muted-foreground">
              {formatMemory(hardware.ram.availableMb)} {t('ONBOARDING_AVAILABLE')}
            </div>
          </div>

          <div data-testid="hw-cpu">
            <div className="text-muted-foreground text-xs">{t('ONBOARDING_CPU')}</div>
            <div className="font-medium">{hardware.cpu.model}</div>
            <div className="text-xs text-muted-foreground">
              {hardware.cpu.cores} {t('ONBOARDING_CORES')} · {hardware.cpu.arch}
            </div>
          </div>
        </div>

        {noGpu && (
          <div className="flex items-start gap-2 p-2.5 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-md">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-yellow-800 dark:text-yellow-200">
              <strong>{t('ONBOARDING_NO_GPU_DETECTED_STRONG')}</strong> {t('ONBOARDING_NO_GPU_DETECTED_DESC')}
            </div>
          </div>
        )}

        {amdHostRocm && (
          <div
            className={cn(
              'mt-3 rounded-md border p-3 text-xs',
              amdHostRocm.tone === 'ready'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                : 'border-border/60 bg-muted/30 text-muted-foreground',
            )}
            data-testid={amdHostRocm.tone === 'ready' ? 'amd-host-rocm-ready' : 'amd-host-rocm-hint'}
          >
            <p className="font-semibold">{amdHostRocm.title}</p>
            <p className="mt-1">{amdHostRocm.body}</p>
          </div>
        )}

        {nvidiaRuntimeMissing && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100" data-testid="nvidia-runtime-warning">
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
                    <div className="mt-1.5 space-y-2">
                      <div className="rounded bg-black/30 p-2.5 font-mono text-[11px] leading-6 text-amber-100/90">
                        <p className="font-semibold text-amber-100">{t('ONBOARDING_DISTRO_DEBIAN_UBUNTU')}</p>
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
                        <p className="font-semibold text-amber-100">{t('ONBOARDING_DISTRO_RHEL_FEDORA')}</p>
                        <p>
                          curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee
                          /etc/yum.repos.d/nvidia-container-toolkit.repo
                        </p>
                        <p>sudo dnf install -y nvidia-container-toolkit</p>
                      </div>

                      <div className="rounded bg-black/30 p-2.5 font-mono text-[11px] leading-6 text-amber-100/90">
                        <p className="font-semibold text-amber-100">{t('ONBOARDING_DISTRO_ARCH_MANJARO')}</p>
                        <p>sudo pacman -Sy --noconfirm nvidia-container-toolkit</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="font-semibold">2. {t('ONBOARDING_COMPLETE_GPU_SUPPORT_HOST')}</p>
                    <div className="mt-1.5 rounded bg-black/30 p-2.5 text-[11px] leading-6 text-amber-100/90">
                      {t('ONBOARDING_COMPLETE_GPU_SUPPORT_HOST_DESC')}
                    </div>
                  </>
                )}
              </div>

              {showLinuxRuntimeSteps && (
                <div>
                  <p className="font-semibold">3. {t('ONBOARDING_THEN_RUN')}</p>
                  <div className="mt-1.5 rounded bg-black/30 p-2.5 font-mono text-[11px] leading-6 text-amber-100/90">
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
            className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-100"
            data-testid="nvidia-runtime-ready"
          >
            {t('ONBOARDING_NVIDIA_RUNTIME_READY')}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
