import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useRevalidator } from 'react-router';
import { useDeepLinkPairCapture } from '@/hooks/use-deep-link-pair-capture';
import { SetupCard } from '@/components/setup/setup-card';
import { SetupPageShell } from '@/components/setup/setup-page-shell';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { DockerAccessStatusPanel } from './docker-access-status-panel';
import { configureHubApiPort, getTauriInvoke, probeHealthyHubApiPort } from '@/lib/tauri-hub-probe';
import { openLogsFolder } from '@/lib/helpers/open-folder';
import {
  DOCKER_MAC_ARCH_HINT,
  DOCKER_REQUIRED_HINT,
  STARTUP_IMAGE_PULL_HINT,
  STARTUP_PROGRESS_HINT,
  STARTUP_SERVICE_HINTS,
} from './hub-status-tooltips';
import { Container, Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';

interface HubStatusProps {
  children: ReactNode;
}

type HubStatusResponse = 'DockerNotAvailable' | 'Stopped' | 'Starting' | 'Running' | { Error: { message: string } };

type ServiceState = 'pending' | 'starting' | 'ready' | 'failed' | 'unavailable';

interface ServiceStatus {
  label: string;
  container: string;
  state: ServiceState;
  optional?: boolean;
}

interface StartupProgress {
  services: ServiceStatus[];
  progress_pct: number;
  image_pulled: number;
  image_total: number;
  image_pull_pct: number;
  all_ready: boolean;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function reloadCurrentWindow() {
  window.location.reload();
}

const HUB_STEADY_SESSION_KEY = 'ci-hub-steady-running';

function readHubSteadySession(): boolean {
  try {
    return sessionStorage.getItem(HUB_STEADY_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markHubSteadySession(): void {
  try {
    sessionStorage.setItem(HUB_STEADY_SESSION_KEY, '1');
  } catch {
    // sessionStorage unavailable — steady-state hints are best-effort only.
  }
}

function clearHubSteadySession(): void {
  try {
    sessionStorage.removeItem(HUB_STEADY_SESSION_KEY);
  } catch {
    // ignore
  }
}

/** True when the user explicitly reloaded the WebView (context menu → Reload). */
export function isUserInitiatedPageReload(): boolean {
  if (typeof performance === 'undefined') {
    return false;
  }
  const getEntriesByType = performance.getEntriesByType?.bind(performance);
  if (!getEntriesByType) {
    return false;
  }
  try {
    const entry = getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return entry?.type === 'reload';
  } catch {
    return false;
  }
}

const HUB_STATUS_POLL_INTERVAL_MS = 3000;

function detectPlatform(): 'windows' | 'macos' | 'linux' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

function isAppleSilicon(): boolean {
  try {
    const uad = (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData;
    if (uad?.architecture) return uad.architecture === 'arm';
    return /arm64|aarch64/i.test(navigator.userAgent) || /Mac/.test(navigator.platform);
  } catch {
    return true;
  }
}

export type DockerDesktopGuidePlatform = 'windows' | 'macos';

export type DockerDesktopGuideContent = {
  platformLabel: string;
  downloadUrl: string;
  alreadyInstalledTitle: string;
  alreadyInstalledSteps: string[];
  notInstalledTitle: string;
  notInstalledSteps: string[];
  hint?: string;
};

export function getDockerDesktopGuideContent(platform: DockerDesktopGuidePlatform, appleSilicon: boolean): DockerDesktopGuideContent {
  if (platform === 'windows') {
    return {
      platformLabel: i18next.t('HUB_STATUS_WINDOWS'),
      downloadUrl: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
      alreadyInstalledTitle: i18next.t('HUB_STATUS_DOCKER_DESKTOP_ALREADY_INSTALLED_TITLE'),
      alreadyInstalledSteps: [
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_WINDOWS_STEP_OPEN_START_MENU'),
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_WINDOWS_STEP_WAIT_TRAY'),
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_STEP_COME_BACK_CONTINUE'),
      ],
      notInstalledTitle: i18next.t('HUB_STATUS_DOCKER_DESKTOP_NOT_INSTALLED_TITLE'),
      notInstalledSteps: [
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_WINDOWS_STEP_DOWNLOAD'),
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_STEP_RUN_INSTALLER'),
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_STEP_RESTART_IF_PROMPTED'),
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_STEP_START_DESKTOP'),
        i18next.t('HUB_STATUS_DOCKER_DESKTOP_STEP_COME_BACK_START'),
      ],
      hint: i18next.t('HUB_STATUS_DOCKER_DESKTOP_WINDOWS_HINT'),
    };
  }

  return {
    platformLabel: i18next.t('HUB_STATUS_MAC'),
    downloadUrl: appleSilicon ? 'https://desktop.docker.com/mac/main/arm64/Docker.dmg' : 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
    alreadyInstalledTitle: i18next.t('HUB_STATUS_DOCKER_DESKTOP_ALREADY_INSTALLED_TITLE'),
    alreadyInstalledSteps: [
      i18next.t('HUB_STATUS_DOCKER_DESKTOP_MAC_STEP_OPEN_APPLICATIONS'),
      i18next.t('HUB_STATUS_DOCKER_DESKTOP_MAC_STEP_WAIT_MENU_BAR'),
      i18next.t('HUB_STATUS_DOCKER_DESKTOP_STEP_COME_BACK_CONTINUE'),
    ],
    notInstalledTitle: i18next.t('HUB_STATUS_DOCKER_DESKTOP_NOT_INSTALLED_TITLE'),
    notInstalledSteps: [
      i18next.t('HUB_STATUS_DOCKER_DESKTOP_MAC_STEP_DOWNLOAD'),
      i18next.t('HUB_STATUS_DOCKER_DESKTOP_MAC_STEP_OPEN_DMG'),
      i18next.t('HUB_STATUS_DOCKER_DESKTOP_MAC_STEP_LAUNCH_GRANT'),
      i18next.t('HUB_STATUS_DOCKER_DESKTOP_STEP_COME_BACK_START'),
    ],
  };
}

interface DockerDesktopGuideProps extends DockerDesktopGuideContent {
  footer?: ReactNode;
  /** Rendered between the Desktop card and the access panel (licensing-free engine option). */
  alternative?: ReactNode;
}

function SetupStepsColumn({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <ol className="space-y-2 text-sm text-muted-foreground">
        {steps.map((step, i) => (
          <li key={step} className="flex gap-2">
            <span className="font-medium text-foreground/80 shrink-0">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DockerDesktopGuide({
  platformLabel,
  downloadUrl,
  alreadyInstalledTitle,
  alreadyInstalledSteps,
  notInstalledTitle,
  notInstalledSteps,
  footer,
  alternative,
}: DockerDesktopGuideProps) {
  const { t } = useTranslation();
  const isMac = platformLabel === 'Mac';
  const [macArch, setMacArch] = useState<'arm' | 'intel'>(isAppleSilicon() ? 'arm' : 'intel');
  const macArmUrl = 'https://desktop.docker.com/mac/main/arm64/Docker.dmg';
  const macIntelUrl = 'https://desktop.docker.com/mac/main/amd64/Docker.dmg';
  const activeDownloadUrl = isMac ? (macArch === 'arm' ? macArmUrl : macIntelUrl) : downloadUrl;

  return (
    <div className="space-y-6 w-full max-w-2xl">
      <SetupCard>
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-start gap-1 flex-wrap">
                <HintText id="docker-required" hint={t(DOCKER_REQUIRED_HINT)} as="h2" className="text-xl font-semibold text-foreground">
                  {t('HUB_STATUS_DOCKER_DESKTOP_REQUIRED')}
                </HintText>
              </div>
              <p className="text-sm text-muted-foreground max-w-lg">{t('HUB_STATUS_DOCKER_DESKTOP_REQUIRED_DESC')}</p>
            </div>
            <Container className="h-10 w-10 shrink-0 text-primary" aria-hidden />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <SetupStepsColumn title={alreadyInstalledTitle} steps={alreadyInstalledSteps} />
            <SetupStepsColumn title={notInstalledTitle} steps={notInstalledSteps} />
          </div>

          <div className="space-y-3">
            <a
              href={activeDownloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Download className="h-4 w-4" aria-hidden />
              {t('HUB_STATUS_DOWNLOAD_DOCKER_DESKTOP_FOR')} {platformLabel}
            </a>
            {isMac && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMacArch('arm')}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${macArch === 'arm' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {t('COMMON_APPLE_SILICON')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMacArch('intel')}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${macArch === 'intel' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {t('HUB_STATUS_INTEL_CHIP')}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  <HintText id="docker-mac-arch" hint={t(DOCKER_MAC_ARCH_HINT)}>
                    {t('HUB_STATUS_WHICH_MAC')}
                  </HintText>
                </p>
              </div>
            )}
            {footer}
          </div>
        </div>
      </SetupCard>

      {alternative}

      <DockerAccessStatusPanel />
    </div>
  );
}

/**
 * Licensing-free engine alternative for macOS (Colima) and Windows (Docker
 * Engine in WSL2). Docker Desktop needs a paid subscription for orgs with
 * >250 employees or >$10M revenue; these run the open-source Engine instead.
 * Desktop-app only — hidden in web clients, which cannot trigger installs.
 */
function EngineAlternativePanel({ platform }: { platform: 'windows' | 'macos' }) {
  const { t } = useTranslation();
  const [installState, setInstallState] = useState<LinuxInstallState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleInstall = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setInstallState('installing');
    setErrorMessage('');
    try {
      const result = (await invoke('install_docker_engine_alternative_command')) as {
        state: 'completed' | 'needs_restart';
        detail: string | null;
      };
      setInstallState(result.state === 'needs_restart' ? 'needs_restart' : 'completed');
    } catch (err) {
      setErrorMessage(getErrorMessage(err));
      setInstallState('error');
    }
  }, []);

  if (!getTauriInvoke()) return null;

  const installLabel = platform === 'macos' ? t('HUB_STATUS_DOCKER_ALT_INSTALL_MAC') : t('HUB_STATUS_DOCKER_ALT_INSTALL_WINDOWS');
  const description = platform === 'macos' ? t('HUB_STATUS_DOCKER_ALT_DESC_MAC') : t('HUB_STATUS_DOCKER_ALT_DESC_WINDOWS');

  return (
    <SetupCard>
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{t('HUB_STATUS_DOCKER_ALT_TITLE')}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>

        {installState === 'idle' && (
          <button
            type="button"
            onClick={handleInstall}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-6 py-3 text-sm font-medium text-foreground cursor-pointer hover:bg-muted"
          >
            {installLabel}
          </button>
        )}

        {installState === 'installing' && (
          <div className="flex items-center justify-center gap-2 rounded-md border border-border px-6 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('HUB_STATUS_DOCKER_ALT_INSTALLING')}
          </div>
        )}

        {(installState === 'completed' || installState === 'needs_restart') && (
          <div className="flex items-start gap-3 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
            <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            <span>{installState === 'needs_restart' ? t('HUB_STATUS_DOCKER_ALT_NEEDS_RESTART') : t('HUB_STATUS_DOCKER_ALT_SUCCESS')}</span>
          </div>
        )}

        {installState === 'error' && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
              <span>{errorMessage || t('HUB_STATUS_DOCKER_ALT_ERROR')}</span>
            </div>
            <button
              type="button"
              onClick={handleInstall}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-6 py-3 text-sm font-medium text-foreground cursor-pointer hover:bg-muted"
            >
              {installLabel}
            </button>
          </div>
        )}
      </div>
    </SetupCard>
  );
}

type LinuxInstallState = 'idle' | 'installing' | 'completed' | 'needs_restart' | 'error';

function LinuxDockerGuide() {
  const { t } = useTranslation();
  const [installState, setInstallState] = useState<LinuxInstallState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleAutoInstall = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setInstallState('installing');
    setErrorMessage('');
    try {
      const result = (await invoke('install_docker_command')) as { state: 'completed' | 'needs_restart'; detail: string | null };
      setInstallState(result.state === 'needs_restart' ? 'needs_restart' : 'completed');
    } catch (err) {
      setErrorMessage(getErrorMessage(err));
      setInstallState('error');
    }
  }, []);

  return (
    <div className="space-y-6 w-full max-w-2xl">
      <SetupCard>
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-start gap-1 flex-wrap">
                <HintText id="docker-linux-required" hint={t(DOCKER_REQUIRED_HINT)} as="h2" className="text-xl font-semibold text-foreground">
                  {t('HUB_STATUS_DOCKER_ENGINE_REQUIRED')}
                </HintText>
              </div>
              <p className="text-sm text-muted-foreground">{t('HUB_STATUS_DOCKER_ENGINE_REQUIRED_DESC')}</p>
            </div>
            <Container className="h-10 w-10 shrink-0 text-primary" aria-hidden />
          </div>

          {installState === 'idle' && (
            <button
              type="button"
              onClick={handleAutoInstall}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('HUB_STATUS_LINUX_AUTO_INSTALL_DOCKER')}
            </button>
          )}

          {installState === 'installing' && (
            <div className="flex items-center justify-center gap-2 rounded-md border border-border px-6 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('HUB_STATUS_LINUX_INSTALLING')}
            </div>
          )}

          {(installState === 'completed' || installState === 'needs_restart') && (
            <div className="flex items-start gap-3 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
              <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
              <span>{installState === 'needs_restart' ? t('HUB_STATUS_LINUX_INSTALL_NEEDS_RESTART') : t('HUB_STATUS_LINUX_INSTALL_SUCCESS')}</span>
            </div>
          )}

          {installState === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
                <span>{errorMessage || t('HUB_STATUS_LINUX_INSTALL_ERROR')}</span>
              </div>
              <button
                type="button"
                onClick={handleAutoInstall}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('HUB_STATUS_LINUX_AUTO_INSTALL_DOCKER')}
              </button>
            </div>
          )}

          <div className="relative flex items-center gap-3">
            <div className="flex-1 border-t border-border" />
            <span className="text-xs text-muted-foreground">{t('HUB_STATUS_LINUX_OR_INSTALL_MANUALLY')}</span>
            <div className="flex-1 border-t border-border" />
          </div>

          <ol className="text-left list-decimal list-inside space-y-1 text-sm text-muted-foreground">
            <li>{t('HUB_STATUS_LINUX_STEP_INSTALL_ENGINE')}</li>
            <li>{t('HUB_STATUS_LINUX_STEP_ADD_USER_GROUP')}</li>
            <li>{t('HUB_STATUS_LINUX_STEP_LOG_OUT')}</li>
            <li>{t('HUB_STATUS_LINUX_STEP_REOPEN_HUB')}</li>
          </ol>
          <div className="text-left bg-muted rounded-md p-3 text-sm font-mono space-y-1">
            <p>curl -fsSL https://get.docker.com | sh</p>
            <p>sudo usermod -aG docker $USER</p>
          </div>
          <a
            href="https://docs.docker.com/engine/install/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:bg-muted"
          >
            {t('HUB_STATUS_VIEW_DOCKER_INSTALL_GUIDE')}
          </a>
        </div>
      </SetupCard>
      <DockerAccessStatusPanel />
    </div>
  );
}

function DockerInstallGuide() {
  const platform = detectPlatform();

  if (platform === 'windows') {
    const guide = getDockerDesktopGuideContent('windows', false);
    return (
      <DockerDesktopGuide
        {...guide}
        footer={guide.hint ? <p className="text-xs text-muted-foreground/70">{guide.hint}</p> : undefined}
        alternative={<EngineAlternativePanel platform="windows" />}
      />
    );
  }

  if (platform === 'macos') {
    const guide = getDockerDesktopGuideContent('macos', isAppleSilicon());
    return (
      <DockerDesktopGuide
        {...guide}
        footer={guide.hint ? <p className="text-xs text-muted-foreground/70">{guide.hint}</p> : undefined}
        alternative={<EngineAlternativePanel platform="macos" />}
      />
    );
  }

  return <LinuxDockerGuide />;
}

// ─── Startup progress screen ─────────────────────────────────────────────────

const SERVICE_ICON: Record<ServiceState, string> = {
  pending: '○',
  starting: '◌',
  ready: '●',
  failed: '✕',
  unavailable: '—',
};

const SERVICE_COLOR: Record<ServiceState, string> = {
  pending: 'text-muted-foreground/40',
  starting: 'text-yellow-500',
  ready: 'text-green-500',
  failed: 'text-destructive',
  unavailable: 'text-muted-foreground/50',
};

function ServiceRow({ service }: { service: ServiceStatus }) {
  const { t } = useTranslation();
  const color = SERVICE_COLOR[service.state];
  const hintKey = STARTUP_SERVICE_HINTS[service.container];
  const hint = hintKey ? t(hintKey) : undefined;
  const label =
    service.state === 'pending'
      ? t('HUB_STATUS_SERVICE_WAITING')
      : service.state === 'starting'
        ? t('HUB_STATUS_SERVICE_STARTING')
        : service.state === 'ready'
          ? t('HUB_STATUS_SERVICE_READY')
          : service.state === 'unavailable'
            ? t('HUB_STATUS_SERVICE_UNAVAILABLE')
            : t('COMMON_FAILED');

  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={`text-sm font-medium tabular-nums ${color} ${service.state === 'starting' ? 'animate-pulse' : ''}`}>
          {SERVICE_ICON[service.state]}
        </span>
        <span className="text-sm text-foreground min-w-0">
          {hint ? (
            <HintText id={`svc-${service.container}`} hint={hint}>
              {service.label}
            </HintText>
          ) : (
            service.label
          )}
        </span>
      </div>
      <span className={`text-xs tabular-nums shrink-0 ${color}`}>{label}</span>
    </div>
  );
}

function StartupScreen({ elapsedSeconds }: { elapsedSeconds: number }) {
  const { t } = useTranslation();
  const invoke = getTauriInvoke();
  const [progress, setProgress] = useState<StartupProgress | null>(null);

  useEffect(() => {
    if (!invoke) return;
    const poll = async () => {
      try {
        const result = (await invoke('get_startup_progress_command')) as StartupProgress;
        setProgress(result);
      } catch {
        // ignore — hub_status polling handles recovery
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => clearInterval(id);
  }, [invoke]);

  const pct = progress?.progress_pct ?? 0;
  const showSlowMessage = elapsedSeconds > 90;
  const showVerySlowMessage = elapsedSeconds > 180;

  // Optional sidecars (Private VPN, tunnel, Ollama) must not block or clutter startup
  // when disconnected — only show them once ready; never count them in progress stats.
  const visibleServices = (progress?.services ?? []).filter((svc) => !svc.optional || svc.state === 'ready');

  const serviceCounts = (progress?.services ?? []).reduce(
    (acc, svc) => {
      if (svc.optional) {
        return acc;
      }
      acc[svc.state] += 1;
      return acc;
    },
    { pending: 0, starting: 0, ready: 0, failed: 0, unavailable: 0 } as Record<ServiceState, number>,
  );

  const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;

  return (
    <SetupCard className="max-w-2xl w-full">
      <div className="flex flex-col items-center gap-6 w-full">
        <div className="text-center space-y-1 w-full">
          <h2 className="text-xl font-semibold text-foreground">{t('HUB_STATUS_STARTING_TITLE')}</h2>
          <p className="text-sm text-muted-foreground">
            {showVerySlowMessage
              ? t('HUB_STATUS_STARTING_STILL_WORKING')
              : showSlowMessage
                ? t('HUB_STATUS_STARTING_ALMOST_THERE')
                : t('HUB_STATUS_STARTING_SERVICES_ONLINE')}
          </p>
          <p className="text-xs text-muted-foreground/80">{t('HUB_STATUS_STARTING_FIRST_STARTUP_NOTE')}</p>
        </div>

        <div className="w-full space-y-1.5">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all duration-700 ease-out" style={{ width: `${Math.max(pct, 4)}%` }} />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground/60 tabular-nums">
            <span className="inline-flex items-center">
              <HintText id="startup-progress" hint={t(STARTUP_PROGRESS_HINT)}>
                {pct}%
              </HintText>
            </span>
            <span>
              {elapsed} {t('HUB_STATUS_ELAPSED')}
            </span>
          </div>
          {progress && (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground/70">
                {serviceCounts.ready} {t('HUB_STATUS_SERVICE_READY')}, {serviceCounts.starting} {t('HUB_STATUS_SERVICE_STARTING')},{' '}
                {serviceCounts.pending} {t('HUB_STATUS_SERVICE_PENDING')}
                {serviceCounts.failed > 0 ? `, ${serviceCounts.failed} ${t('COMMON_FAILED')}` : ''}
              </div>
              <div className="text-xs text-muted-foreground/70">
                <HintText id="startup-image-pull" hint={t(STARTUP_IMAGE_PULL_HINT)}>
                  {t('HUB_STATUS_IMAGE_PULLS')}: {progress.image_pulled}/{progress.image_total} ({progress.image_pull_pct}%)
                </HintText>
              </div>
            </div>
          )}
        </div>

        {visibleServices.length > 0 ? (
          <div className="w-full rounded-lg border border-border bg-muted/30 px-4 divide-y divide-border/50">
            {visibleServices.map((svc) => (
              <ServiceRow key={svc.container} service={svc} />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <svg
              className="h-4 w-4 animate-spin text-primary"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              role="img"
              aria-label={t('COMMON_LOADING')}
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">{t('HUB_STATUS_INITIALISING')}</span>
          </div>
        )}
      </div>
    </SetupCard>
  );
}

// ─── Main HubStatus gate ──────────────────────────────────────────────────────

export function HubStatus({ children }: HubStatusProps) {
  const { t } = useTranslation();
  const { revalidate } = useRevalidator();
  useDeepLinkPairCapture();
  const [status, setStatus] = useState<HubStatusResponse | null>(null);
  const [startupElapsed, setStartupElapsed] = useState(0);
  const [logs, setLogs] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const startupStartRef = useRef<number | null>(null);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isWindows = isTauri && detectPlatform() === 'windows';
  const shouldAutoStartWindowsHubRef = useRef(true);
  const stackDevModeRef = useRef<boolean | null>(null);
  const checkStatusInFlightRef = useRef(false);
  // Track whether we've seen a non-Running state so we can reload once the Hub
  // becomes healthy. Without this, React Router's cached clientLoader errors
  // from startup (when the backend wasn't ready) would persist as stale
  // ErrorBoundary renders even after the Hub comes up.
  const sawNonRunningRef = useRef(false);
  const hasReloadedRef = useRef(false);
  /** Once the hub has reached Running, ignore transient Starting (e.g. Tailscale sidecar or health blips). */
  const hubSteadyRunningRef = useRef(readHubSteadySession());

  const checkHealthFallback = useCallback(async () => {
    const port = await probeHealthyHubApiPort(true);
    if (port !== null) {
      setStatus('Running');
      return;
    }
    sawNonRunningRef.current = true;
    setStatus('Stopped');
  }, []);

  const startHub = useCallback(async (logMessage: string) => {
    const invoke = getTauriInvoke();
    if (!invoke) return false;

    hubSteadyRunningRef.current = false;
    setStatus('Starting');

    try {
      await invoke('start_hub_command');
      return true;
    } catch (err) {
      console.error(logMessage, err);
      setStatus({ Error: { message: getErrorMessage(err) } });
      return false;
    }
  }, []);

  const isStackDevMode = useCallback(async () => {
    if (stackDevModeRef.current !== null) return stackDevModeRef.current;

    const invoke = getTauriInvoke();
    if (!invoke) {
      stackDevModeRef.current = false;
      return false;
    }

    try {
      stackDevModeRef.current = Boolean(await invoke('is_stack_dev_mode_command'));
    } catch {
      stackDevModeRef.current = false;
    }

    return stackDevModeRef.current;
  }, []);

  const checkStatus = useCallback(async () => {
    if (checkStatusInFlightRef.current) return;
    checkStatusInFlightRef.current = true;
    try {
      const invoke = getTauriInvoke();
      if (invoke) {
        try {
          const result = (await invoke('get_hub_status_command')) as HubStatusResponse;

          if (isWindows && !(await isStackDevMode())) {
            if (result === 'DockerNotAvailable') {
              shouldAutoStartWindowsHubRef.current = true;
            } else if (result === 'Running' || result === 'Starting' || (typeof result === 'object' && 'Error' in result)) {
              shouldAutoStartWindowsHubRef.current = false;
            } else if (result === 'Stopped' && shouldAutoStartWindowsHubRef.current) {
              shouldAutoStartWindowsHubRef.current = false;
              await startHub(t('HUB_STATUS_FAILED_AUTO_START'));
              return;
            }
          }

          const isHardNonRunning =
            result === 'Stopped' || result === 'DockerNotAvailable' || (typeof result === 'object' && result !== null && 'Error' in result);

          if (isHardNonRunning) {
            hubSteadyRunningRef.current = false;
            clearHubSteadySession();
            sawNonRunningRef.current = true;
            setStatus(result);
            return;
          }

          // Docker may report Starting while ci-os-hub is already serving HTTP (healthcheck
          // lag, sidecar churn). The local API probe is the UI gate — not container health alone.
          // Match Docker's ci-os-hub healthcheck (`/api/health/live` only).
          if (result === 'Running' || result === 'Starting') {
            const alivePort = await probeHealthyHubApiPort();
            if (alivePort !== null) {
              configureHubApiPort(alivePort);
              setStatus('Running');
              return;
            }

            // API probe failed — treat as non-running even if we were steady before.
            hubSteadyRunningRef.current = false;
            clearHubSteadySession();
            sawNonRunningRef.current = true;
            setStatus('Starting');
            return;
          }

          sawNonRunningRef.current = true;
          setStatus(result);
        } catch {
          await checkHealthFallback();
        }
      } else if (isTauri) {
        await checkHealthFallback();
      }
    } finally {
      checkStatusInFlightRef.current = false;
    }
  }, [isTauri, isWindows, checkHealthFallback, isStackDevMode, startHub, t]);

  // Track elapsed seconds while in Starting state
  useEffect(() => {
    if (status === 'Running') {
      hubSteadyRunningRef.current = true;
      markHubSteadySession();
    } else if (status === 'Stopped' || status === 'DockerNotAvailable' || (typeof status === 'object' && status !== null && 'Error' in status)) {
      hubSteadyRunningRef.current = false;
      clearHubSteadySession();
    }
  }, [status]);

  useEffect(() => {
    if (status === 'Starting') {
      if (startupStartRef.current === null) {
        startupStartRef.current = Date.now();
      }
      const id = setInterval(() => {
        setStartupElapsed(Math.floor((Date.now() - (startupStartRef.current ?? Date.now())) / 1000));
      }, 1000);
      return () => clearInterval(id);
    }
    startupStartRef.current = null;
    setStartupElapsed(0);
  }, [status]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, HUB_STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handleStartHub = useCallback(async () => {
    shouldAutoStartWindowsHubRef.current = false;
    await startHub(t('HUB_STATUS_FAILED_START'));
  }, [startHub, t]);

  const handleRestartHub = useCallback(async () => {
    shouldAutoStartWindowsHubRef.current = false;
    await startHub(t('HUB_STATUS_FAILED_RESTART'));
  }, [startHub, t]);

  // When the Hub transitions from a non-running state to Running, route loaders
  // that failed during startup (backend wasn't ready) would stay stale in React
  // Router's cache. Reload once so clientLoader runs against the healthy backend.
  useEffect(() => {
    if (!isTauri || status !== 'Running' || !sawNonRunningRef.current || hasReloadedRef.current) {
      return;
    }
    hasReloadedRef.current = true;
    // User reload already re-ran clientLoader — revalidate routes instead of reloading again.
    if (isUserInitiatedPageReload()) {
      void revalidate();
      return;
    }
    try {
      reloadCurrentWindow();
    } catch {
      // JSDOM in tests doesn't support navigation; ignore safely.
    }
  }, [status, isTauri, revalidate]);

  const handleViewLogs = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    try {
      const logContent = (await invoke('read_desktop_logs_command')) as string;
      setLogs(logContent);
      setShowLogs(true);
    } catch {
      // Fallback: open the logs directory instead
      await openLogsFolder();
    }
  }, []);

  const handleOpenLogsDir = useCallback(async () => {
    await openLogsFolder();
  }, []);

  // If not in Tauri, don't block the UI — web users have the backend proxied
  if (!isTauri) return <>{children}</>;

  // Dark placeholder while the first hub status poll runs (avoids blank flash)
  if (status === null) {
    return (
      <SetupPageShell title={t('APP_NAME')} contentClassName="items-center">
        <div className="flex justify-center py-16" role="status" aria-busy="true" aria-label={t('HUB_STATUS_CHECKING')}>
          <svg
            className="h-8 w-8 animate-spin text-primary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            role="img"
            aria-label={t('COMMON_LOADING')}
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      </SetupPageShell>
    );
  }

  // Hub is running — stay on the app if we've already reached Running (don't regress to the
  // loading gate when Private VPN / health checks flap during steady operation).
  if (status === 'Running' || (hubSteadyRunningRef.current && status === 'Starting')) {
    return <>{children}</>;
  }

  // Error message extraction
  const errorMessage = typeof status === 'object' && 'Error' in status ? status.Error.message : null;

  const gateTitle = status === 'DockerNotAvailable' ? t('COMMON_SET_UP_YOUR_HUB') : t('APP_NAME');

  return (
    <SetupPageShell title={gateTitle} contentClassName="items-center">
      <div className="flex flex-col items-center gap-6 w-full">
        {status === 'DockerNotAvailable' && <DockerInstallGuide />}

        {status === 'Stopped' && (
          <SetupCard className="max-w-md w-full text-center">
            <h2 className="text-xl font-semibold text-foreground mb-2">{t('HUB_STATUS_NOT_RUNNING')}</h2>
            <p className="text-muted-foreground mb-6">{t('HUB_STATUS_BACKEND_NOT_RUNNING')}</p>
            <button
              type="button"
              onClick={handleStartHub}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('HUB_STATUS_START_HUB')}
            </button>
            <div className="flex gap-4 justify-center mt-6">
              <button type="button" onClick={handleViewLogs} className="text-sm text-muted-foreground underline hover:text-foreground">
                {t('HUB_STATUS_VIEW_LOGS')}
              </button>
              <button type="button" onClick={handleOpenLogsDir} className="text-sm text-muted-foreground underline hover:text-foreground">
                {t('HUB_STATUS_OPEN_LOGS_FOLDER')}
              </button>
            </div>
          </SetupCard>
        )}

        {status === 'Starting' && <StartupScreen elapsedSeconds={startupElapsed} />}

        {errorMessage && (
          <SetupCard className="max-w-md w-full text-center">
            <h2 className="text-xl font-semibold text-foreground mb-2">{t('HUB_STATUS_ERROR')}</h2>
            <p className="text-muted-foreground mb-6">{errorMessage}</p>
            <button
              type="button"
              onClick={handleRestartHub}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('HUB_STATUS_RESTART_HUB')}
            </button>
            <div className="flex gap-4 justify-center mt-6">
              <button type="button" onClick={handleViewLogs} className="text-sm text-muted-foreground underline hover:text-foreground">
                {t('HUB_STATUS_VIEW_LOGS')}
              </button>
              <button type="button" onClick={handleOpenLogsDir} className="text-sm text-muted-foreground underline hover:text-foreground">
                {t('HUB_STATUS_OPEN_LOGS_FOLDER')}
              </button>
            </div>
          </SetupCard>
        )}

        {status !== 'Starting' && status !== 'DockerNotAvailable' && !errorMessage && (
          <button type="button" onClick={() => checkStatus()} className="text-sm text-muted-foreground underline hover:text-foreground">
            {t('COMMON_CHECK_AGAIN')}
          </button>
        )}

        {showLogs && logs !== null && (
          <div className="w-full max-w-2xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">{t('HUB_STATUS_RECENT_LOGS')}</span>
              <button type="button" onClick={() => setShowLogs(false)} className="text-sm text-muted-foreground underline hover:text-foreground">
                {t('HUB_STATUS_HIDE')}
              </button>
            </div>
            <pre className="bg-muted rounded-md p-3 text-xs font-mono text-muted-foreground max-h-64 overflow-auto whitespace-pre-wrap">
              {logs || t('HUB_STATUS_NO_LOGS_AVAILABLE')}
            </pre>
          </div>
        )}
      </div>
    </SetupPageShell>
  );
}
