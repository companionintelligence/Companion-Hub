import { colorizeLogLine } from '@/lib/log-ansi';
import { POLLING } from '@/lib/polling-budget';
import { useResolvedTheme } from '@/lib/use-resolved-theme';
import DOMPurify from 'dompurify';
import '@/components/logs-terminal/logs-terminal.css';
import { useMemo, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useRevalidator } from 'react-router';
import { useAppIntentDeepLinks } from '@/hooks/use-app-intent-deep-links';
import { useDeepLinkPairCapture } from '@/hooks/use-deep-link-pair-capture';
import { isMobileClient, isTauriMobileSync, isCloudConnectPath } from '@/lib/mobile-connection';
import { SetupCard } from '@/components/setup/setup-card';
import { SetupPageShell } from '@/components/setup/setup-page-shell';
import { Button } from '@/components/ui/Button';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { cn } from '@/lib/utils';
import { DockerAccessStatusPanel } from './docker-access-status-panel';
import { configureHubApiPort, isViteLocalFrontend, probeHealthyHubApiPort } from '@/lib/tauri-hub-probe';
import { getTauriInvoke, type TauriInvoke } from '@/lib/helpers/tauri-invoke';
import {
  clearHubSteadySession,
  clearStackUpdatePending,
  isStackUpdatePending,
  markHubSteadySession,
  readHubSteadySession,
} from '@/lib/desktop-stack-session';
import { openLogsFolder } from '@/lib/helpers/open-folder';
import { DOCKER_MAC_ARCH_HINT, DOCKER_REQUIRED_HINT, STARTUP_SERVICE_HINTS } from './hub-status-tooltips';
import { Container, Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';

interface HubStatusProps {
  children: ReactNode;
}

type HubStatusError = { Error: { message: string } };

type HubStatusResponse = 'DockerNotAvailable' | 'Stopped' | 'Starting' | 'Running' | HubStatusError;

function isErrorStatus(status: HubStatusResponse | null): status is HubStatusError {
  return typeof status === 'object' && status !== null && 'Error' in status;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Tauri denied the invoke — the Hub never tried to start. Keep the raw ACL text for logs. */
function formatHubStartError(err: unknown, aclHint: string, previousSticky?: string): string {
  const raw = getErrorMessage(err);
  if (raw.includes('not allowed by ACL')) {
    // Do not let an ACL denial replace a real sticky start failure (e.g. Postgres probe).
    if (previousSticky && !previousSticky.includes('not allowed by ACL')) {
      return `${previousSticky}\n\n${aclHint}\n\n${raw}`;
    }
    return `${aclHint}\n\n${raw}`;
  }
  return raw;
}

export function reloadCurrentWindow() {
  window.location.reload();
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

const HUB_STATUS_POLL_INTERVAL_MS = POLLING.HUB_STATUS_MS;

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
                  {t('HUB_STATUS_DOCKER_REQUIRED')}
                </HintText>
              </div>
              <p className="text-sm text-muted-foreground max-w-lg">{t('HUB_STATUS_DOCKER_REQUIRED_DESC')}</p>
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
          <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
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
            <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
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
        footer={guide.hint ? <p className="text-xs text-muted-foreground">{guide.hint}</p> : undefined}
        alternative={<EngineAlternativePanel platform="windows" />}
      />
    );
  }

  if (platform === 'macos') {
    const guide = getDockerDesktopGuideContent('macos', isAppleSilicon());
    return (
      <DockerDesktopGuide
        {...guide}
        footer={guide.hint ? <p className="text-xs text-muted-foreground">{guide.hint}</p> : undefined}
        alternative={<EngineAlternativePanel platform="macos" />}
      />
    );
  }

  return <LinuxDockerGuide />;
}

// ─── Startup screens: starting, stuck, stopped, couldn't start ────────────────
//
// The in-app half of the Hub's startup screen. The desktop bootstrap page
// (packages/desktop/bootstrap/) shows the same screens until the Hub API answers and then
// hands over to these mid-startup, so the two must look and read the same.

/** Starting this long turns into "hasn't finished starting". Keep waiting adds as much again. */
const STUCK_AFTER_SECONDS = 180;
/** After this long, a View logs link joins the starting screen. */
const LOGS_LINK_AFTER_SECONDS = 90;
const STARTUP_PROGRESS_POLL_MS = 2000;
const COPIED_FEEDBACK_MS = 2000;

type ServiceState = 'pending' | 'starting' | 'ready' | 'failed' | 'stopped' | 'not_started';

interface ServiceStatus {
  label: string;
  container: string;
  state: ServiceState;
  /** Optional sidecars (Tunnel, Private VPN, Ollama) are not shown on these screens. */
  optional: boolean;
  /** For `failed`: Docker's error for the container, or its exit code. */
  detail: string | null;
  /** For `starting`: seconds since the container started. */
  starting_secs: number | null;
}

type DockerAccessState = 'available' | 'permission_denied' | 'daemon_unavailable' | 'not_installed' | 'error';

/** What `get_startup_progress_command` reports, as far as these screens use it. */
interface StartupProgress {
  services: ServiceStatus[];
  progress_pct: number;
  image_pulled: number;
  image_total: number;
  image_pull_pct: number;
  start_in_progress: boolean;
  user_stopped: boolean;
  user_stopped_at_ms: number | null;
  start_failed_at_ms: number | null;
  docker_access: DockerAccessState;
  hub_api_live: boolean;
}

const SERVICE_STATES: ReadonlySet<string> = new Set<ServiceState>(['pending', 'starting', 'ready', 'failed', 'stopped', 'not_started']);
const DOCKER_ACCESS_STATES: ReadonlySet<string> = new Set<DockerAccessState>([
  'available',
  'permission_denied',
  'daemon_unavailable',
  'not_installed',
  'error',
]);

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readServiceStatus(raw: unknown): ServiceStatus[] {
  if (!raw || typeof raw !== 'object') return [];
  const service = raw as Record<string, unknown>;
  const container = typeof service.container === 'string' ? service.container : '';
  return [
    {
      label: typeof service.label === 'string' ? service.label : container,
      container,
      // Core services never report `unavailable`; anything unrecognised reads as waiting.
      state: typeof service.state === 'string' && SERVICE_STATES.has(service.state) ? (service.state as ServiceState) : 'pending',
      optional: service.optional === true,
      detail: typeof service.detail === 'string' && service.detail.trim() !== '' ? service.detail.trim() : null,
      starting_secs: finiteOrNull(service.starting_secs),
    },
  ];
}

function readDockerAccess(raw: unknown): DockerAccessState {
  const state = raw && typeof raw === 'object' ? (raw as { state?: unknown }).state : undefined;
  if (state === undefined || state === null) return 'available';
  return typeof state === 'string' && DOCKER_ACCESS_STATES.has(state) ? (state as DockerAccessState) : 'error';
}

/**
 * Read a startup-progress payload. The Hub container serving this page can be newer or older
 * than the desktop shell answering the command, so whatever an older shell leaves out reads as
 * false, null, or (for Docker) available.
 */
function readStartupProgress(raw: unknown): StartupProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;
  return {
    services: Array.isArray(payload.services) ? payload.services.flatMap(readServiceStatus) : [],
    progress_pct: Math.min(100, Math.max(0, finiteOrNull(payload.progress_pct) ?? 0)),
    image_pulled: finiteOrNull(payload.image_pulled) ?? 0,
    image_total: finiteOrNull(payload.image_total) ?? 0,
    image_pull_pct: finiteOrNull(payload.image_pull_pct) ?? 0,
    start_in_progress: payload.start_in_progress === true,
    user_stopped: payload.user_stopped === true,
    user_stopped_at_ms: finiteOrNull(payload.user_stopped_at_ms),
    start_failed_at_ms: finiteOrNull(payload.start_failed_at_ms),
    docker_access: readDockerAccess(payload.docker_access),
    hub_api_live: payload.hub_api_live === true,
  };
}

interface PolledStartupProgress {
  progress: StartupProgress;
  /** When it arrived: `starting_secs` keeps counting between polls. */
  receivedAt: number;
}

/** Poll the desktop shell's per-container startup progress while a startup screen is showing. */
function useStartupProgress(): PolledStartupProgress | null {
  const [polled, setPolled] = useState<PolledStartupProgress | null>(null);

  useEffect(() => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const progress = readStartupProgress(await invoke('get_startup_progress_command'));
        if (active && progress) {
          setPolled({ progress, receivedAt: Date.now() });
        }
      } catch {
        // Keep the last known state; hub status polling handles recovery.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), STARTUP_PROGRESS_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return polled;
}

const NO_BREAK_SPACE = '\u00a0';

/** m:ss, with minutes past 59 left as they are. */
function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "Sep 16", kept on one line. */
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).replaceAll(' ', NO_BREAK_SPACE);
}

/** "9:25 PM", kept on one line. */
function formatTimeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replaceAll(' ', NO_BREAK_SPACE);
}

/** Copy with the Clipboard API, or a hidden textarea where that is unavailable or refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (insecure context, permissions): fall back below.
  }
  // Selecting the textarea moves focus; hand it back to the button that asked.
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previousFocus?.focus();
  }
}

const SERVICE_STATE_LABEL: Record<ServiceState, string> = {
  pending: 'HUB_STATUS_SERVICE_WAITING',
  starting: 'HUB_STATUS_SERVICE_STARTING',
  ready: 'HUB_STATUS_SERVICE_READY',
  failed: 'HUB_STATUS_SERVICE_FAILED',
  stopped: 'HUB_STATUS_SERVICE_STOPPED',
  not_started: 'HUB_STATUS_SERVICE_NOT_STARTED',
};

/** State label colours follow the mark. */
const SERVICE_STATE_TONE: Record<ServiceState, string> = {
  pending: 'text-muted-foreground',
  starting: 'text-warning',
  ready: 'text-success',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  not_started: 'text-muted-foreground',
};

/** The couldn't-start line names the service Docker could not start (current and legacy container names). */
const FAILED_SERVICE_LINE: Record<string, string> = {
  'ci-hub-db': 'HUB_STATUS_FAILED_DATABASE_LINE',
  'ci-hub-queue': 'HUB_STATUS_FAILED_QUEUE_LINE',
  'ci-os-hub-queue': 'HUB_STATUS_FAILED_QUEUE_LINE',
  'ci-hub': 'HUB_STATUS_FAILED_BACKEND_LINE',
  'ci-os-hub': 'HUB_STATUS_FAILED_BACKEND_LINE',
  traefik: 'HUB_STATUS_FAILED_ROUTER_LINE',
};

interface FactValue {
  key: string;
  tone?: string;
}

const DOCKER_FACT: Record<DockerAccessState, FactValue> = {
  available: { key: 'HUB_STATUS_DOCKER_RUNNING' },
  daemon_unavailable: { key: 'HUB_STATUS_DOCKER_NOT_RUNNING', tone: 'text-destructive' },
  not_installed: { key: 'HUB_STATUS_DOCKER_NOT_INSTALLED', tone: 'text-destructive' },
  permission_denied: { key: 'HUB_STATUS_DOCKER_NO_PERMISSION', tone: 'text-destructive' },
  error: { key: 'HUB_STATUS_DOCKER_UNREACHABLE', tone: 'text-destructive' },
};

/** Always counted, zero or not. */
const ALWAYS_COUNTED: ServiceState[] = ['ready', 'starting', 'pending', 'failed'];
/** Counted only when they happen. */
const COUNTED_WHEN_PRESENT: ServiceState[] = ['stopped', 'not_started'];

const ACTION_BUTTON_CLASS = 'h-10 min-w-[164px] px-5 font-semibold focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-card';
const OUTLINE_BUTTON_CLASS = 'border-primary/30 bg-transparent text-foreground shadow-none';

/** One mark per state, drawn rather than typed so every platform renders it the same. */
function StatusMark({ state }: { state: ServiceState }) {
  switch (state) {
    case 'ready':
      return <span aria-hidden="true" className="size-[10px] shrink-0 rounded-full bg-success" />;
    case 'starting':
      // One SVG, so the dot stays centred in the ring. As a bordered span with an inset
      // dot, each box was rounded to device pixels separately and the dot drifted.
      return (
        <svg aria-hidden="true" viewBox="0 0 10 10" fill="none" className="size-[10px] shrink-0 text-warning">
          <circle cx="5" cy="5" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="5" cy="5" r="1.5" fill="currentColor" className="animate-pulse motion-reduce:animate-none" />
        </svg>
      );
    case 'failed':
      return (
        <svg aria-hidden="true" viewBox="0 0 10 10" fill="none" className="size-[10px] shrink-0 overflow-visible text-destructive">
          <path d="M1.46 1.46l7.08 7.08M8.54 1.46l-7.08 7.08" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'stopped':
      return <span aria-hidden="true" className="size-[9px] shrink-0 rounded-[2px] bg-muted-foreground" />;
    case 'not_started':
      return <span aria-hidden="true" className="size-[10px] shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground" />;
    default:
      return <span aria-hidden="true" className="size-[10px] shrink-0 rounded-full border-[1.5px] border-muted-foreground" />;
  }
}

interface ServiceRowProps {
  service: ServiceStatus;
  /** Replaces the state label, e.g. "Starting for 3:12" on the stuck service. */
  stateLabel?: string;
  /** What went wrong, in monospace under the row. */
  detail?: string | null;
  /** The service holding up startup. */
  attention?: boolean;
}

function ServiceRow({ service, stateLabel, detail, attention = false }: ServiceRowProps) {
  const { t } = useTranslation();
  const hintKey = STARTUP_SERVICE_HINTS[service.container];

  return (
    <li className={cn('px-4 py-2 compact-window:py-[5px]', attention && 'bg-primary/6', service.state === 'failed' && 'bg-destructive/8')}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5 text-sm leading-normal text-foreground">
          <StatusMark state={service.state} />
          {hintKey ? (
            <HintText id={`svc-${service.container}`} hint={t(hintKey)}>
              {service.label}
            </HintText>
          ) : (
            <span>{service.label}</span>
          )}
        </div>
        <span className={cn('shrink-0 text-xs tabular-nums', SERVICE_STATE_TONE[service.state])}>
          {stateLabel ?? t(SERVICE_STATE_LABEL[service.state])}
        </span>
      </div>
      {detail && (
        // Four lines at most, so a long compose error cannot push the actions off screen; Copy error has the rest.
        <p className="mt-1.5 mb-0.5 ml-5 max-h-[6.4em] overflow-y-auto whitespace-pre-wrap font-mono compact-window:max-h-[4.8em] text-[12px] leading-[1.6] text-foreground [overflow-wrap:anywhere]">
          {detail}
        </p>
      )}
    </li>
  );
}

function StatusFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="mr-6 flex gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-medium tabular-nums text-foreground', tone)}>{value}</dd>
    </div>
  );
}

/** Muted, underlined, no box — with a full-size hit area. */
function QuietAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[44px] cursor-pointer items-center rounded-sm px-2.5 text-[13.5px] text-muted-foreground underline decoration-muted-foreground/45 underline-offset-[3px] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function InitialisingRow() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-2 text-muted-foreground">
      <svg
        className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span className="text-sm">{t('HUB_STATUS_INITIALISING')}</span>
    </div>
  );
}

/** The screen a `get_hub_status_command` result maps to. `starting` becomes stuck by itself. */
type StartupScreenStatus = 'starting' | 'stopped' | 'failed';

type StartupView = StartupScreenStatus | 'stuck';

interface StartupScreenProps {
  status: StartupScreenStatus;
  /** The `{ Error }` status message, for the couldn't-start screen. */
  errorMessage: string | null;
  /** Seconds since the current wait began. */
  elapsedSeconds: number;
  /** The elapsed second at which starting becomes "hasn't finished starting". */
  stuckAfterSeconds: number;
  /** How long this page's own start ran before it failed, or null when the page did not run it. */
  failedAfterSeconds: number | null;
  onStart: () => void;
  onRestart: () => void;
  onKeepWaiting: () => void;
  /** Push the stuck deadline out to at least this elapsed second. */
  onHoldStuckDeadline: (elapsedSeconds: number) => void;
  onViewLogs: () => void;
}

/**
 * The starting, "hasn't finished starting", stopped and couldn't-start screens: one card with the
 * progress bar, a status panel read from `get_startup_progress_command`, and the actions for
 * the screen. It stays mounted while the status moves between them, so the panel never blanks.
 */
function StartupScreen({
  status,
  errorMessage,
  elapsedSeconds,
  stuckAfterSeconds,
  failedAfterSeconds,
  onStart,
  onRestart,
  onKeepWaiting,
  onHoldStuckDeadline,
  onViewLogs,
}: StartupScreenProps) {
  const { t } = useTranslation();
  const polled = useStartupProgress();
  const progress = polled?.progress ?? null;
  const [copied, setCopied] = useState(false);

  // Only a start that is running pulls images: a mismatched image name must not read as a
  // download that never ends.
  const downloading = Boolean(progress?.start_in_progress && progress.image_pulled < progress.image_total);

  // Never stuck while downloading; the services get their three minutes once the download ends.
  useEffect(() => {
    if (status === 'starting' && downloading) {
      onHoldStuckDeadline(elapsedSeconds + STUCK_AFTER_SECONDS);
    }
  }, [status, downloading, elapsedSeconds, onHoldStuckDeadline]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(id);
  }, [copied]);

  const view: StartupView = status === 'starting' && !downloading && elapsedSeconds >= stuckAfterSeconds ? 'stuck' : status;
  const core = progress ? progress.services.filter((service) => !service.optional) : [];
  const dockerReady = !progress || progress.docker_access === 'available';
  const failedService = core.find((service) => service.state === 'failed') ?? null;

  // The service that has been starting the longest. A container in a restart loop keeps
  // resetting its own start time, so never report less than this page has waited.
  const stuckService =
    view === 'stuck'
      ? (core.filter((service) => service.state === 'starting').sort((a, b) => (b.starting_secs ?? 0) - (a.starting_secs ?? 0))[0] ?? null)
      : null;
  const stuckSeconds =
    stuckService && polled
      ? Math.max((stuckService.starting_secs ?? 0) + Math.floor((Date.now() - polled.receivedAt) / 1000), elapsedSeconds)
      : elapsedSeconds;

  const errorText = status === 'failed' ? errorMessage?.trim() || null : null;
  // Docker's own words go under the failed service's row; the status message stands in when the
  // shell sent none, and sits in the panel when no core service failed.
  const rowDetail = (service: ServiceStatus) => {
    if (service.state !== 'failed') return null;
    return service === failedService ? (service.detail ?? errorText) : service.detail;
  };
  const panelError = failedService ? null : errorText;
  const errorToCopy = [...new Set([failedService?.detail, errorText].filter((text): text is string => Boolean(text)))].join('\n\n');

  let title: string;
  let line: string;
  let timeText: string;
  switch (view) {
    case 'stuck': {
      const count = Math.max(1, Math.floor(stuckSeconds / 60));
      title = t('HUB_STATUS_STUCK_TITLE');
      line = stuckService ? t('HUB_STATUS_STUCK_SERVICE_LINE', { service: stuckService.label, count }) : t('HUB_STATUS_STUCK_HUB_LINE', { count });
      timeText = t('HUB_STATUS_ELAPSED_TIME', { time: formatClock(elapsedSeconds) });
      break;
    }
    case 'stopped': {
      const stoppedAt = progress?.user_stopped ? progress.user_stopped_at_ms : null;
      const when = stoppedAt === null ? null : { date: formatDay(stoppedAt), time: formatTimeOfDay(stoppedAt) };
      if (!progress) {
        // Until the first poll says whether the user stopped it, don't guess which it was.
        title = t('HUB_STATUS_STOPPED_TITLE');
        line = '';
      } else if (progress.user_stopped) {
        title = t('HUB_STATUS_STOPPED_TITLE');
        line = when ? t('HUB_STATUS_STOPPED_AT_LINE', when) : t('HUB_STATUS_STOPPED_LINE');
      } else {
        title = t('HUB_STATUS_NOT_RUNNING_TITLE');
        line = t('HUB_STATUS_NOT_RUNNING_LINE');
      }
      timeText = when ? t('HUB_STATUS_STOPPED_SINCE', when) : t('HUB_STATUS_NOT_RUNNING_META');
      break;
    }
    case 'failed': {
      const lineKey = failedService ? FAILED_SERVICE_LINE[failedService.container] : undefined;
      const failedAt = progress?.start_failed_at_ms ?? null;
      title = t('HUB_STATUS_FAILED_TITLE');
      line = t(lineKey ?? 'HUB_STATUS_FAILED_LINE');
      if (failedAfterSeconds !== null) {
        timeText = t('HUB_STATUS_FAILED_AFTER', { time: formatClock(failedAfterSeconds) });
      } else if (failedAt === null) {
        timeText = t('HUB_STATUS_FAILED_META');
      } else {
        timeText = t('HUB_STATUS_FAILED_AT', { time: formatTimeOfDay(failedAt) });
      }
      break;
    }
    default:
      title = t('HUB_STATUS_STARTING_TITLE');
      line = downloading ? t('HUB_STATUS_STARTING_DOWNLOADING') : t('HUB_STATUS_STARTING_SERVICES_ONLINE');
      timeText = t('HUB_STATUS_ELAPSED_TIME', { time: formatClock(elapsedSeconds) });
  }

  // A stopped Hub reads 0% whatever the containers score.
  const pct = progress && view !== 'stopped' ? progress.progress_pct : 0;
  const barWidth = view === 'starting' || view === 'stuck' ? Math.max(pct, 4) : pct;

  let hubApi: FactValue = { key: 'HUB_STATUS_API_NOT_RUNNING' };
  if (progress?.hub_api_live) {
    hubApi = { key: 'HUB_STATUS_API_ANSWERING' };
  } else if (view === 'stuck') {
    hubApi = { key: 'HUB_STATUS_API_NOT_ANSWERING', tone: 'text-warning' };
  } else if (view === 'starting') {
    hubApi = { key: 'HUB_STATUS_API_NOT_ANSWERING_YET' };
  }

  const countOf = (state: ServiceState) => core.filter((service) => service.state === state).length;
  const counts: { state: ServiceState; count: number | null }[] = dockerReady
    ? [
        ...ALWAYS_COUNTED.map((state) => ({ state, count: countOf(state) })),
        ...COUNTED_WHEN_PRESENT.map((state) => ({ state, count: countOf(state) })).filter(({ count }) => count > 0),
      ]
    : ALWAYS_COUNTED.map((state) => ({ state, count: null }));

  const handleCopyError = async () => {
    if (errorToCopy && (await copyText(errorToCopy))) {
      setCopied(true);
    }
  };

  return (
    <SetupCard className="w-full max-w-2xl" contentClassName="tight-window:px-8 tight-window:py-6 compact-window:px-[24px] compact-window:py-[22px]">
      <div className="flex flex-col gap-5 tight-window:gap-4 compact-window:gap-3.5">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h2 className="text-xl font-semibold leading-[1.3] text-foreground">{title}</h2>
          <p role="status" className="w-full text-sm leading-[1.55] text-muted-foreground">
            {line}
          </p>
        </div>

        {progress ? (
          <>
            <div className="flex flex-col gap-2">
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out motion-reduce:transition-none"
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <div className="flex justify-between gap-4 text-xs tabular-nums text-muted-foreground">
                <span>
                  <span className="sr-only">{t('HUB_STATUS_PROGRESS_LABEL')} </span>
                  {pct}%
                </span>
                <span>{timeText}</span>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
              <dl className="flex flex-wrap gap-y-1.5 border-b border-border px-4 py-2.5 text-xs compact-window:py-[7px]">
                <StatusFact
                  label={t('HUB_STATUS_FACT_IMAGES')}
                  value={
                    dockerReady
                      ? t('HUB_STATUS_FACT_IMAGES_VALUE', {
                          pulled: progress.image_pulled,
                          total: progress.image_total,
                          pct: progress.image_pull_pct,
                        })
                      : '—'
                  }
                />
                <StatusFact
                  label={t('HUB_STATUS_FACT_DOCKER')}
                  value={t(DOCKER_FACT[progress.docker_access].key)}
                  tone={DOCKER_FACT[progress.docker_access].tone}
                />
                <StatusFact label={t('HUB_STATUS_FACT_HUB_API')} value={t(hubApi.key)} tone={hubApi.tone} />
              </dl>

              {dockerReady ? (
                <ul className="divide-y divide-border">
                  {core.map((service) => (
                    <ServiceRow
                      key={service.container || service.label}
                      service={service}
                      attention={service === stuckService}
                      stateLabel={service === stuckService ? t('HUB_STATUS_SERVICE_STARTING_FOR', { time: formatClock(stuckSeconds) }) : undefined}
                      detail={rowDetail(service)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-3 text-[13.5px] text-muted-foreground">{t('HUB_STATUS_SERVICES_AFTER_DOCKER')}</p>
              )}

              {panelError && (
                <p className="max-h-[calc(6.4em_+_1.25rem)] overflow-y-auto whitespace-pre-wrap compact-window:max-h-[calc(4.8em_+_1.25rem)] border-t border-border bg-destructive/8 px-4 py-2.5 font-mono text-[12px] leading-[1.6] text-foreground [overflow-wrap:anywhere]">
                  {panelError}
                </p>
              )}

              <ul className="flex flex-wrap items-center gap-y-1.5 border-t border-border px-4 py-2.5 text-xs text-muted-foreground compact-window:py-[7px]">
                {counts.map(({ state, count }) => (
                  <li key={state} className={cn('mr-5 inline-flex items-center gap-[7px] tabular-nums', !count && 'opacity-55')}>
                    <StatusMark state={state} />
                    <span className="font-semibold text-foreground">{count ?? '—'}</span>
                    <span>{t(SERVICE_STATE_LABEL[state])}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <InitialisingRow />
        )}

        {view === 'starting' && elapsedSeconds > LOGS_LINK_AFTER_SECONDS && (
          <div className="flex justify-center">
            <QuietAction onClick={onViewLogs}>{t('HUB_STATUS_VIEW_LOGS')}</QuietAction>
          </div>
        )}

        {view === 'stuck' && (
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <Button type="button" className={ACTION_BUTTON_CLASS} onClick={onRestart}>
              {t('HUB_STATUS_RESTART_HUB')}
            </Button>
            <Button type="button" variant="outline" className={cn(ACTION_BUTTON_CLASS, OUTLINE_BUTTON_CLASS)} onClick={onKeepWaiting}>
              {t('HUB_STATUS_KEEP_WAITING')}
            </Button>
            <QuietAction onClick={onViewLogs}>{t('HUB_STATUS_VIEW_LOGS')}</QuietAction>
          </div>
        )}

        {view === 'stopped' && (
          <div className="flex flex-col items-center gap-1.5">
            <Button type="button" className={ACTION_BUTTON_CLASS} onClick={onStart}>
              {t('HUB_STATUS_START_HUB')}
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">{t('HUB_STATUS_START_USUALLY_QUICK')}</p>
          </div>
        )}

        {view === 'failed' && (
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <Button type="button" className={ACTION_BUTTON_CLASS} onClick={onStart}>
              {t('HUB_STATUS_TRY_AGAIN')}
            </Button>
            {errorToCopy && (
              <QuietAction onClick={() => void handleCopyError()}>{copied ? t('HUB_STATUS_COPIED') : t('HUB_STATUS_COPY_ERROR')}</QuietAction>
            )}
            <QuietAction onClick={onViewLogs}>{t('HUB_STATUS_VIEW_LOGS')}</QuietAction>
            <span role="status" className="sr-only">
              {copied ? t('HUB_STATUS_ERROR_COPIED') : ''}
            </span>
          </div>
        )}
      </div>
    </SetupCard>
  );
}

// ─── Main HubStatus gate ──────────────────────────────────────────────────────

type HubStartCommand = 'start_hub_command' | 'restart_hub_command';

/** Tauri refused the command itself (not on this origin's IPC allowlist, or an older shell without it). */
function isCommandUnavailable(err: unknown): boolean {
  return /not allowed by ACL|command \S+ not found/i.test(getErrorMessage(err));
}

/**
 * Run a start or a restart. When the shell will not let this page restart, start instead, so
 * Restart Hub still does something rather than failing on an ACL error.
 */
async function invokeHubStart(invoke: TauriInvoke, command: HubStartCommand): Promise<void> {
  if (command === 'restart_hub_command') {
    try {
      await invoke('restart_hub_command');
      return;
    } catch (err) {
      if (!isCommandUnavailable(err)) throw err;
    }
  }
  await invoke('start_hub_command');
}

export function HubStatus({ children }: HubStatusProps) {
  const { t } = useTranslation();
  const { revalidate } = useRevalidator();
  useDeepLinkPairCapture();
  useAppIntentDeepLinks();
  const [status, setStatus] = useState<HubStatusResponse | null>(null);
  const [startupElapsed, setStartupElapsed] = useState(0);
  const [stuckAfterSeconds, setStuckAfterSeconds] = useState(STUCK_AFTER_SECONDS);
  const [failedAfterSeconds, setFailedAfterSeconds] = useState<number | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const resolvedTheme = useResolvedTheme();
  const renderedLogs = useMemo(() => {
    if (!logs) {
      return DOMPurify.sanitize(t('HUB_STATUS_NO_LOGS_AVAILABLE'));
    }

    return logs
      .split('\n')
      .map((line) => DOMPurify.sanitize(colorizeLogLine(line, resolvedTheme)))
      .join('<br />');
  }, [logs, resolvedTheme, t]);
  /** When the current wait for the Hub began. */
  const startupStartRef = useRef<number | null>(null);
  /** This page's own start or restart command is still running. */
  const startCommandRunningRef = useRef(false);
  /** This page ran the latest start, so a failure can say how long it ran. */
  const startedHereRef = useRef(false);
  /** Why this page's own start was rejected. Stays on screen until something else starts the Hub. */
  const startCommandErrorRef = useRef<string | null>(null);
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
  const consecutiveProbeFailuresRef = useRef(0);

  const checkHealthFallback = useCallback(async () => {
    const port = await probeHealthyHubApiPort(true);
    if (port !== null) {
      consecutiveProbeFailuresRef.current = 0;
      setStatus('Running');
      return;
    }
    // After the hub has been steady, keep the app mounted — only hard Docker
    // non-running states (Stopped / Error) should regress the startup gate.
    if (hubSteadyRunningRef.current) {
      consecutiveProbeFailuresRef.current += 1;
      setStatus('Running');
      return;
    }
    // This page's own start is still running: stay on the starting screen.
    if (startCommandRunningRef.current) {
      return;
    }
    sawNonRunningRef.current = true;
    setStatus('Stopped');
  }, []);

  const statusRef = useRef(status);
  statusRef.current = status;

  const startHub = useCallback(
    async (logMessage: string, command: HubStartCommand = 'start_hub_command') => {
      const invoke = getTauriInvoke();
      if (!invoke) return false;

      const current = statusRef.current;
      const previousSticky = isErrorStatus(current) ? current.Error.message : undefined;

      hubSteadyRunningRef.current = false;
      startCommandRunningRef.current = true;
      startedHereRef.current = true;
      startCommandErrorRef.current = null;
      // A new wait: the buttons go at once, and the clock and the stuck deadline start over.
      startupStartRef.current = Date.now();
      setStartupElapsed(0);
      setStuckAfterSeconds(STUCK_AFTER_SECONDS);
      setFailedAfterSeconds(null);
      setStatus('Starting');

      try {
        await invokeHubStart(invoke, command);
        return true;
      } catch (err) {
        console.error(logMessage, err);
        const message = formatHubStartError(err, t('HUB_STATUS_ACL_DENIED'), previousSticky);
        startCommandErrorRef.current = message;
        setStatus({ Error: { message } });
        return false;
      } finally {
        startCommandRunningRef.current = false;
      }
    },
    [t],
  );

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
          // `local:desktop` talks to source Nest via the Vite proxy. Docker
          // compose status is the appliance stack (often a leftover :5002 Hub)
          // and must not gate this UI.
          if (isViteLocalFrontend()) {
            await checkHealthFallback();
            return;
          }

          let result = (await invoke('get_hub_status_command')) as HubStatusResponse;

          // This page's own start or restart is still running. A restart takes the stack down
          // first, so the shell reports Stopped for a while: keep the starting screen.
          if (startCommandRunningRef.current && (result === 'Stopped' || isErrorStatus(result))) {
            return;
          }
          if (result === 'Starting' || result === 'Running') {
            // Something else started the Hub: this page's failed attempt is history.
            startCommandErrorRef.current = null;
          } else if (startCommandErrorRef.current && (result === 'Stopped' || isErrorStatus(result))) {
            // Keep this page's rejected start on screen; the shell may not have recorded it.
            result = { Error: { message: startCommandErrorRef.current } };
          }

          if (isWindows && !(await isStackDevMode())) {
            if (result === 'DockerNotAvailable') {
              shouldAutoStartWindowsHubRef.current = true;
            } else if (result === 'Running' || result === 'Starting' || isErrorStatus(result)) {
              shouldAutoStartWindowsHubRef.current = false;
            } else if (result === 'Stopped' && shouldAutoStartWindowsHubRef.current) {
              shouldAutoStartWindowsHubRef.current = false;
              await startHub(t('HUB_STATUS_FAILED_AUTO_START'));
              return;
            }
          }

          const isHardNonRunning = result === 'Stopped' || result === 'DockerNotAvailable' || isErrorStatus(result);

          if (isHardNonRunning) {
            consecutiveProbeFailuresRef.current = 0;
            hubSteadyRunningRef.current = false;
            clearHubSteadySession();
            sawNonRunningRef.current = true;
            setStatus(result);
            return;
          }

          // Docker may report Starting while ci-hub is already serving HTTP (healthcheck
          // lag, sidecar churn). The local API probe is the UI gate — not container health alone.
          // Match Docker's ci-hub healthcheck (`/api/health/live` only).
          if (result === 'Running' || result === 'Starting') {
            const alivePort = await probeHealthyHubApiPort();
            if (alivePort !== null) {
              consecutiveProbeFailuresRef.current = 0;
              configureHubApiPort(alivePort);
              setStatus('Running');
              return;
            }

            // After steady, tolerate probe misses so Docker healthcheck lag / CPU
            // spikes do not flash the startup gate. Hard stops clear steady above.
            if (hubSteadyRunningRef.current) {
              consecutiveProbeFailuresRef.current += 1;
              setStatus('Running');
              return;
            }

            consecutiveProbeFailuresRef.current = 0;
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

  useEffect(() => {
    if (status === 'Running') {
      hubSteadyRunningRef.current = true;
      markHubSteadySession();
    } else if (status === 'Stopped' || status === 'DockerNotAvailable' || isErrorStatus(status)) {
      hubSteadyRunningRef.current = false;
      clearHubSteadySession();
    }
  }, [status]);

  // Track the wait while Starting: elapsed seconds, and how long a start this page ran lasted
  // before it failed.
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
    if (isErrorStatus(status)) {
      if (startedHereRef.current && startupStartRef.current !== null) {
        setFailedAfterSeconds(Math.floor((Date.now() - startupStartRef.current) / 1000));
      }
    } else {
      startedHereRef.current = false;
      setFailedAfterSeconds(null);
    }
    startupStartRef.current = null;
    setStartupElapsed(0);
    setStuckAfterSeconds(STUCK_AFTER_SECONDS);
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
    await startHub(t('HUB_STATUS_FAILED_RESTART'), 'restart_hub_command');
  }, [startHub, t]);

  const handleKeepWaiting = useCallback(() => {
    const elapsed = startupStartRef.current === null ? 0 : Math.floor((Date.now() - startupStartRef.current) / 1000);
    setStuckAfterSeconds(elapsed + STUCK_AFTER_SECONDS);
  }, []);

  const holdStuckDeadline = useCallback((elapsedSeconds: number) => {
    setStuckAfterSeconds((current) => Math.max(current, elapsedSeconds));
  }, []);

  // When the Hub transitions from a non-running state to Running, route loaders
  // that failed during startup (backend wasn't ready) would stay stale in React
  // Router's cache. Prefer revalidate over a full window reload so a brief API
  // blip after steady does not flash the loading gate.
  useEffect(() => {
    if (!isTauri || status !== 'Running' || !sawNonRunningRef.current || hasReloadedRef.current) {
      return;
    }
    hasReloadedRef.current = true;
    void revalidate();
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

  // If not in Tauri, don't block the UI — web users have the backend proxied.
  // On mobile there is no *local* Hub to manage (no Docker on a phone): the app
  // is a thin client pointed at a remote Hub, so this local-Hub gate (and its
  // desktop-only commands / localhost probes) doesn't apply. The remote Hub's
  // reachability is handled by the connect flow and the normal app loaders.
  // /connect must never be replaced by the local-Hub spinner — that is the
  // one-second flash then black screen on the iOS Simulator.
  const onConnectScreen = typeof window !== 'undefined' && isCloudConnectPath(window.location.pathname);
  if (!isTauri || isTauriMobileSync() || isMobileClient() || onConnectScreen || import.meta.env.VITE_HUB_RUNTIME === 'mobile') return <>{children}</>;

  // Dark placeholder while the first hub status poll runs (avoids blank flash)
  if (status === null) {
    return (
      <SetupPageShell title={t('APP_NAME')} className="bg-transparent" contentClassName="items-center" fitShortWindows>
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

  // Hub is running — render the app. After a stack update, reload once so the WebView
  // picks up the new container UI bundle (same origin, new hashed assets).
  if (status === 'Running') {
    if (isStackUpdatePending()) {
      clearStackUpdatePending();
      if (!hasReloadedRef.current) {
        hasReloadedRef.current = true;
        reloadCurrentWindow();
        return null;
      }
    }
    return <>{children}</>;
  }

  // During stack recreate, show the startup gate — not stale app UI with a dead API.
  if (isStackUpdatePending()) {
    // fall through to Starting / Stopped gate screens below
  } else if (hubSteadyRunningRef.current && status === 'Starting') {
    return <>{children}</>;
  }

  const gateTitle = status === 'DockerNotAvailable' ? t('COMMON_SET_UP_YOUR_HUB') : t('APP_NAME');
  let screenStatus: StartupScreenStatus = 'starting';
  if (status === 'Stopped') {
    screenStatus = 'stopped';
  } else if (isErrorStatus(status)) {
    screenStatus = 'failed';
  }

  return (
    // Transparent so the body's background lift shows, as on the desktop bootstrap page.
    <SetupPageShell title={gateTitle} className="bg-transparent" contentClassName="items-center" fitShortWindows>
      <div className="flex flex-col items-center gap-6 w-full max-w-3xl px-4">
        {status === 'DockerNotAvailable' ? (
          <DockerInstallGuide />
        ) : (
          <StartupScreen
            status={screenStatus}
            errorMessage={isErrorStatus(status) ? status.Error.message : null}
            elapsedSeconds={startupElapsed}
            stuckAfterSeconds={stuckAfterSeconds}
            failedAfterSeconds={failedAfterSeconds}
            onStart={() => void handleStartHub()}
            onRestart={() => void handleRestartHub()}
            onKeepWaiting={handleKeepWaiting}
            onHoldStuckDeadline={holdStuckDeadline}
            onViewLogs={() => void handleViewLogs()}
          />
        )}

        {showLogs && logs !== null && (
          <div className="w-full max-w-2xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">{t('HUB_STATUS_RECENT_LOGS')}</span>
              <button type="button" onClick={() => setShowLogs(false)} className="text-sm text-muted-foreground underline hover:text-foreground">
                {t('HUB_STATUS_HIDE')}
              </button>
            </div>
            <pre
              className="log-terminal log-terminal--panel wrap-lines"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized ANSI output from local log files
              dangerouslySetInnerHTML={{ __html: renderedLogs }}
            />
          </div>
        )}
      </div>
    </SetupPageShell>
  );
}
