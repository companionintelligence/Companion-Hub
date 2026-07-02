import { fetchRocmInstallStatus, rescanInferenceHardware, saveRocmInstallState } from '@/lib/inference/inference-api';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { openExternal } from '@/lib/helpers/open-external';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import type { HardwareProfile } from '@ci-hub/common/types';
import { isAmdApu, resolveAmdHostRocmNotice } from '@/modules/onboarding/helpers/hardware-display';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Download, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const AMD_ROCM_DOCS_URL = 'https://rocm.docs.amd.com/';
const AMD_WSL_DOCS_URL = 'https://rocm.docs.amd.com/projects/radeon/en/latest/docs/install/wsl/install-radeon.html';
const AMD_DRIVERS_URL = 'https://www.amd.com/en/support/download/drivers.html';

type RocmInstallPhase = 'idle' | 'downloading' | 'installing' | 'reboot_required' | 'failed' | 'completed';

interface RocmInstallStatus {
  hostRocmAvailable: boolean;
  hostRocmKfdAvailable?: boolean;
  runtimeRocmAvailable: boolean;
  installPhase: RocmInstallPhase;
  installMessage?: string;
  canAutoInstall: boolean;
  platformHint: 'linux-ubuntu' | 'linux-other' | 'windows' | 'macos' | 'unknown';
}

interface RocmSetupCardProps {
  hardware: HardwareProfile;
  onRescan: () => Promise<void>;
  rescanning?: boolean;
  id?: string;
}

function isWindowsClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  return platform.includes('win');
}

export const RocmSetupCard = ({ hardware, onRescan, rescanning = false, id = 'rocm-setup' }: RocmSetupCardProps) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RocmInstallStatus | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const unmounted = useRef(false);

  const canAutoInstall = getTauriInvoke() !== null;

  const fetchStatus = useCallback(async () => {
    try {
      const data = await fetchRocmInstallStatus<RocmInstallStatus>();
      if (data && !unmounted.current) setStatus(data);
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    unmounted.current = false;
    void fetchStatus();
    return () => {
      unmounted.current = true;
    };
  }, [fetchStatus]);

  const hostRocmKfdAvailable = status?.hostRocmKfdAvailable ?? hardware.gpu.hostRocmKfdAvailable ?? false;
  const runtimeRocmAvailable = status?.runtimeRocmAvailable ?? false;
  const rocmReady = hostRocmKfdAvailable || runtimeRocmAvailable;
  const installPhase = status?.installPhase ?? 'idle';
  const installHintNotice = resolveAmdHostRocmNotice(hardware);

  const handleInstall = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setInstallBusy(true);
    setInstallError('');
    try {
      await saveRocmInstallState({ phase: 'downloading', message: t('AI_ROCM_INSTALLING') });
      const result = (await invoke('install_rocm_command')) as { state?: string; detail?: string };
      await fetchStatus();
      if (result?.state === 'failed') {
        setInstallError(result.detail ?? t('AI_ROCM_INSTALL_FAILED'));
      }
    } catch (err) {
      if (unmounted.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setInstallError(message);
      await saveRocmInstallState({ phase: 'failed', message });
    } finally {
      if (!unmounted.current) setInstallBusy(false);
    }
  }, [fetchStatus, t]);

  const handleVerify = useCallback(async () => {
    setInstallBusy(true);
    setInstallError('');
    try {
      const invoke = getTauriInvoke();
      if (invoke) {
        await invoke('verify_rocm_command');
      }
      await rescanInferenceHardware();
      await onRescan();
      await fetchStatus();
    } catch (err) {
      if (!unmounted.current) {
        setInstallError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!unmounted.current) setInstallBusy(false);
    }
  }, [fetchStatus, onRescan]);

  if (rocmReady) {
    return (
      <Card className="mt-4 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950" id={id} data-testid="amd-host-rocm-ready">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-medium text-green-900 dark:text-green-100">{t('AI_ROCM_DETECTED_TITLE')}</div>
                <div className="text-xs text-green-700 dark:text-green-300 mt-1">
                  {isAmdApu(hardware) ? t('AI_ROCM_DETECTED_APU_BODY', { model: hardware.gpu.model }) : t('AI_ROCM_DETECTED_BODY')}
                </div>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={handleVerify} loading={rescanning || installBusy} aria-label={t('ONBOARDING_RESCAN')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const platformHint = status?.platformHint ?? (isWindowsClient() ? 'windows' : 'unknown');
  const showUbuntuInstall = platformHint === 'linux-ubuntu' && status?.canAutoInstall !== false;
  const showWindowsGuidance = platformHint === 'windows' || isWindowsClient();
  const showManualLinux = platformHint === 'linux-other' || platformHint === 'linux-ubuntu';
  const rebootRequired = installPhase === 'reboot_required';
  const installing = installBusy || installPhase === 'downloading' || installPhase === 'installing';

  return (
    <Card className="mt-4 border-border bg-muted/40" id={id} data-testid="amd-host-rocm-hint">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Download className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">{installHintNotice?.title ?? t('AI_ROCM_AMD_DETECTED_TITLE')}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {installHintNotice?.body ??
                (isAmdApu(hardware) ? t('AI_ROCM_AMD_DETECTED_APU_BODY', { model: hardware.gpu.model }) : t('AI_ROCM_AMD_DETECTED_BODY'))}
            </p>

            {rebootRequired && (
              <div
                className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
                data-testid="rocm-reboot-required"
              >
                <p className="font-semibold">{t('AI_ROCM_REBOOT_REQUIRED_TITLE')}</p>
                <p className="mt-1">{t('AI_ROCM_REBOOT_REQUIRED_BODY')}</p>
              </div>
            )}

            {installError && (
              <div className="mt-3 flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{installError}</span>
              </div>
            )}

            {installing && !rebootRequired && (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="rocm-installing">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                {status?.installMessage ?? t('AI_ROCM_INSTALLING')}
              </div>
            )}

            {!installing && <p className="mt-2 text-xs text-muted-foreground">{t('AI_ROCM_INSTALL_SIZE_WARNING')}</p>}

            <div className="mt-3 flex flex-wrap gap-2">
              {rebootRequired ? (
                <Button size="sm" onClick={handleVerify} loading={installBusy || rescanning} data-testid="rocm-verify-btn">
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  {t('AI_ROCM_VERIFY_BUTTON')}
                </Button>
              ) : showUbuntuInstall && canAutoInstall && !installing ? (
                <Button size="sm" onClick={handleInstall} data-testid="rocm-install-btn">
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  {t('AI_ROCM_INSTALL_BUTTON')}
                </Button>
              ) : null}
              {!rebootRequired && (
                <Button variant="ghost" size="sm" onClick={handleVerify} loading={rescanning || installBusy}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  {t('ONBOARDING_RESCAN')}
                </Button>
              )}
            </div>

            {showWindowsGuidance && (
              <div className="mt-4 rounded-md border border-border bg-background/60 p-3 text-xs" data-testid="rocm-windows-guidance">
                <p className="font-semibold">{t('AI_ROCM_WINDOWS_TITLE')}</p>
                <p className="mt-1 text-muted-foreground">{t('AI_ROCM_WINDOWS_BODY')}</p>
                <div className="mt-2 flex flex-wrap gap-3">
                  <button type="button" className="font-medium underline underline-offset-2" onClick={() => openExternal(AMD_DRIVERS_URL)}>
                    {t('AI_ROCM_WINDOWS_DRIVERS_LINK')}
                  </button>
                  <button type="button" className="font-medium underline underline-offset-2" onClick={() => openExternal(AMD_WSL_DOCS_URL)}>
                    {t('AI_ROCM_WSL_DOCS_LINK')}
                  </button>
                </div>
              </div>
            )}

            {showManualLinux && (
              <div className="mt-4">
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium text-foreground"
                  onClick={() => setManualOpen((open) => !open)}
                  data-testid="rocm-manual-toggle"
                >
                  {manualOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {t('AI_ROCM_MANUAL_TITLE')}
                </button>
                {manualOpen && (
                  <div className="mt-2 space-y-2 text-xs">
                    <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                      <p className="font-semibold font-sans">{t('AI_ROCM_MANUAL_UBUNTU')}</p>
                      <p>. /etc/os-release</p>
                      <p>wget https://repo.radeon.com/amdgpu-install/latest/ubuntu/${'{VERSION_CODENAME}'}/amdgpu-install_*_all.deb</p>
                      <p>sudo apt install ./amdgpu-install_*_all.deb</p>
                      <p>sudo amdgpu-install -y --usecase=rocm</p>
                    </div>
                    <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                      <p className="font-semibold font-sans">{t('AI_ROCM_MANUAL_FEDORA')}</p>
                      <p>sudo dnf install rocm</p>
                    </div>
                    <div className="rounded bg-muted p-2.5 font-mono text-[11px] leading-6">
                      <p className="font-semibold font-sans">{t('ONBOARDING_DISTRO_ARCH_MANJARO')}</p>
                      <p>sudo pacman -S rocm-smi-lib rocm-opencl-runtime</p>
                    </div>
                    <p className="text-muted-foreground">{t('AI_ROCM_MANUAL_POST')}</p>
                    <button type="button" className="font-medium underline underline-offset-2" onClick={() => openExternal(AMD_ROCM_DOCS_URL)}>
                      {t('AI_ROCM_AMD_DOCS_LINK')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
