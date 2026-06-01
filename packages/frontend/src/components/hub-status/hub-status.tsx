import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { client } from '@/api-client/client.gen';
import { SetupCard } from '@/components/setup/setup-card';
import { SetupPageShell } from '@/components/setup/setup-page-shell';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { DockerAccessStatusPanel } from './docker-access-status-panel';
import {
  DOCKER_MAC_ARCH_HINT,
  DOCKER_REQUIRED_HINT,
  STARTUP_IMAGE_PULL_HINT,
  STARTUP_PROGRESS_HINT,
  STARTUP_SERVICE_HINTS,
} from './hub-status-tooltips';
import { Container, Download } from 'lucide-react';

interface HubStatusProps {
  children: ReactNode;
}

type HubStatusResponse = 'DockerNotAvailable' | 'Stopped' | 'Starting' | 'Running' | { Error: { message: string } };

type ServiceState = 'pending' | 'starting' | 'ready' | 'failed';

interface ServiceStatus {
  label: string;
  container: string;
  state: ServiceState;
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

/**
 * Hub listens on 5002 (Docker / typical) or 3000 (some dev setups). We probe both **in parallel**
 * with one Abort deadline each (`TAURI_HUB_HEALTH_PROBE_MS`), so one poll cycle stays bounded by ~that
 * duration—not twice it as with sequential tries.
 *
 * Keep `TAURI_HUB_HEALTH_PROBE_MS` strictly less than `HUB_STATUS_POLL_INTERVAL_MS`: the outer `checkStatus` timer
 * fires every 3s; a longer probe deadline would allow overlapping polls when both ports time out.
 */
const HUB_STATUS_POLL_INTERVAL_MS = 3000;
const TAURI_HUB_HEALTH_PROBE_PORTS = [5002, 3000] as const;
/** Parallel probes ⇒ wall-clock ≈ this value; must stay under the poll interval to avoid stacked ticks. */
const TAURI_HUB_HEALTH_PROBE_MS = 2500;

async function fetchFirstHealthyHubPort(): Promise<number | null> {
  const outcomes = await Promise.all(
    TAURI_HUB_HEALTH_PROBE_PORTS.map(async (port) => {
      try {
        const res = await fetch(`http://localhost:${port}/api/health`, {
          signal: AbortSignal.timeout(TAURI_HUB_HEALTH_PROBE_MS),
        });
        return res.ok ? port : null;
      } catch {
        return null;
      }
    }),
  );
  // Promise.all preserves TAURI_HUB_HEALTH_PROBE_PORTS order — first ok wins.
  return outcomes.find((p) => p !== null) ?? null;
}

// Tauri IPC helper
function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } })
      .__TAURI_INTERNALS__.invoke;
  }
  return null;
}

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
      platformLabel: 'Windows',
      downloadUrl: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
      alreadyInstalledTitle: 'If Docker Desktop is already installed:',
      alreadyInstalledSteps: [
        'Open Docker Desktop from your Start Menu',
        "Wait for Docker to start (you'll see the whale icon in your system tray)",
        'Come back here — the Hub will continue automatically',
      ],
      notInstalledTitle: 'If Docker Desktop is NOT installed:',
      notInstalledSteps: [
        'Download Docker Desktop for Windows',
        'Run the installer and follow the prompts',
        'Restart your computer if prompted',
        'Start Docker Desktop',
        'Come back here — the Hub will start automatically',
      ],
      hint: 'Docker Desktop requires Windows 10/11 with WSL2 enabled. If WSL is installed during setup, restart Windows before reopening Companion Hub.',
    };
  }

  return {
    platformLabel: 'Mac',
    downloadUrl: appleSilicon ? 'https://desktop.docker.com/mac/main/arm64/Docker.dmg' : 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
    alreadyInstalledTitle: 'If Docker Desktop is already installed:',
    alreadyInstalledSteps: [
      'Open Docker Desktop from your Applications folder',
      "Wait for Docker to start (you'll see the whale icon in your menu bar)",
      'Come back here — the Hub will continue automatically',
    ],
    notInstalledTitle: 'If Docker Desktop is NOT installed:',
    notInstalledSteps: [
      'Download Docker Desktop for Mac',
      'Open the .dmg and drag Docker to Applications',
      'Launch Docker Desktop and grant permissions',
      'Come back here — the Hub will start automatically',
    ],
  };
}

interface DockerDesktopGuideProps extends DockerDesktopGuideContent {
  footer?: ReactNode;
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
}: DockerDesktopGuideProps) {
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
                <HintText id="docker-required" hint={DOCKER_REQUIRED_HINT} as="h2" className="text-xl font-semibold text-foreground">
                  Docker Desktop Required
                </HintText>
              </div>
              <p className="text-sm text-muted-foreground max-w-lg">
                Companion Hub needs Docker Desktop to run your apps and services. We&apos;ll automatically detect when Docker is ready.
              </p>
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
              Download Docker Desktop for {platformLabel}
            </a>
            {isMac && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMacArch('arm')}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${macArch === 'arm' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    Apple Silicon
                  </button>
                  <button
                    type="button"
                    onClick={() => setMacArch('intel')}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${macArch === 'intel' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    Intel Chip
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  <HintText id="docker-mac-arch" hint={DOCKER_MAC_ARCH_HINT}>
                    Which Mac do I have?
                  </HintText>
                </p>
              </div>
            )}
            {footer}
          </div>
        </div>
      </SetupCard>

      <DockerAccessStatusPanel />
    </div>
  );
}

function LinuxDockerGuide() {
  return (
    <div className="space-y-6 w-full max-w-2xl">
      <SetupCard>
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-start gap-1 flex-wrap">
                <HintText id="docker-linux-required" hint={DOCKER_REQUIRED_HINT} as="h2" className="text-xl font-semibold text-foreground">
                  Docker Engine Required
                </HintText>
              </div>
              <p className="text-sm text-muted-foreground">Companion Hub requires Docker to run.</p>
            </div>
            <Container className="h-10 w-10 shrink-0 text-primary" aria-hidden />
          </div>
          <ol className="text-left list-decimal list-inside space-y-1 text-sm text-muted-foreground">
            <li>Install Docker Engine for your Linux distribution</li>
            <li>Add your user to the docker group</li>
            <li>Log out and back in, or restart your machine</li>
            <li>Reopen Companion Hub</li>
          </ol>
          <div className="text-left bg-muted rounded-md p-3 text-sm font-mono space-y-1">
            <p>curl -fsSL https://get.docker.com | sh</p>
            <p>sudo usermod -aG docker $USER</p>
          </div>
          <a
            href="https://docs.docker.com/engine/install/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            View Docker Install Guide
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
    return <DockerDesktopGuide {...guide} footer={guide.hint ? <p className="text-xs text-muted-foreground/70">{guide.hint}</p> : undefined} />;
  }

  if (platform === 'macos') {
    const guide = getDockerDesktopGuideContent('macos', isAppleSilicon());
    return <DockerDesktopGuide {...guide} footer={guide.hint ? <p className="text-xs text-muted-foreground/70">{guide.hint}</p> : undefined} />;
  }

  return <LinuxDockerGuide />;
}

// ─── Startup progress screen ─────────────────────────────────────────────────

const SERVICE_ICON: Record<ServiceState, string> = {
  pending: '○',
  starting: '◌',
  ready: '●',
  failed: '✕',
};

const SERVICE_COLOR: Record<ServiceState, string> = {
  pending: 'text-muted-foreground/40',
  starting: 'text-yellow-500',
  ready: 'text-green-500',
  failed: 'text-destructive',
};

const SERVICE_LABEL: Record<ServiceState, string> = {
  pending: 'Waiting…',
  starting: 'Starting…',
  ready: 'Ready',
  failed: 'Failed',
};

function ServiceRow({ service }: { service: ServiceStatus }) {
  const color = SERVICE_COLOR[service.state];
  const hint = STARTUP_SERVICE_HINTS[service.container];

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
      <span className={`text-xs tabular-nums shrink-0 ${color}`}>{SERVICE_LABEL[service.state]}</span>
    </div>
  );
}

function StartupScreen({ elapsedSeconds }: { elapsedSeconds: number }) {
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

  const serviceCounts = (progress?.services ?? []).reduce(
    (acc, svc) => {
      acc[svc.state] += 1;
      return acc;
    },
    { pending: 0, starting: 0, ready: 0, failed: 0 } as Record<ServiceState, number>,
  );

  const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;

  return (
    <SetupCard className="max-w-2xl w-full">
      <div className="flex flex-col items-center gap-6 w-full">
        <div className="text-center space-y-1 w-full">
          <h2 className="text-xl font-semibold text-foreground">Starting Companion Hub</h2>
          <p className="text-sm text-muted-foreground">
            {showVerySlowMessage
              ? 'Still working — Docker images may be downloading for the first time.'
              : showSlowMessage
                ? 'Almost there — some services are taking longer than usual.'
                : 'Services are coming online…'}
          </p>
          <p className="text-xs text-muted-foreground/80">This might take a minute on first startup while containers are pulled.</p>
        </div>

        <div className="w-full space-y-1.5">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all duration-700 ease-out" style={{ width: `${Math.max(pct, 4)}%` }} />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground/60 tabular-nums">
            <span className="inline-flex items-center">
              <HintText id="startup-progress" hint={STARTUP_PROGRESS_HINT}>
                {pct}%
              </HintText>
            </span>
            <span>{elapsed} elapsed</span>
          </div>
          {progress && (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground/70">
                {serviceCounts.ready} ready, {serviceCounts.starting} starting, {serviceCounts.pending} pending
                {serviceCounts.failed > 0 ? `, ${serviceCounts.failed} failed` : ''}
              </div>
              <div className="text-xs text-muted-foreground/70">
                <HintText id="startup-image-pull" hint={STARTUP_IMAGE_PULL_HINT}>
                  Image pulls: {progress.image_pulled}/{progress.image_total} ({progress.image_pull_pct}%)
                </HintText>
              </div>
            </div>
          )}
        </div>

        {progress && progress.services.length > 0 ? (
          <div className="w-full rounded-lg border border-border bg-muted/30 px-4 divide-y divide-border/50">
            {progress.services.map((svc) => (
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
              aria-label="Loading"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Initialising…</span>
          </div>
        )}
      </div>
    </SetupCard>
  );
}

// ─── Main HubStatus gate ──────────────────────────────────────────────────────

export function HubStatus({ children }: HubStatusProps) {
  const [status, setStatus] = useState<HubStatusResponse | null>(null);
  const [startupElapsed, setStartupElapsed] = useState(0);
  const [logs, setLogs] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const startupStartRef = useRef<number | null>(null);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isTauriRelease = isTauri && !window.location.origin.startsWith('http://localhost:');
  const isWindows = isTauri && detectPlatform() === 'windows';
  const shouldAutoStartWindowsHubRef = useRef(true);
  const checkStatusInFlightRef = useRef(false);
  // Track whether we've seen a non-Running state so we can reload once the Hub
  // becomes healthy. Without this, React Router's cached clientLoader errors
  // from startup (when the backend wasn't ready) would persist as stale
  // ErrorBoundary renders even after the Hub comes up.
  const sawNonRunningRef = useRef(false);
  const hasReloadedRef = useRef(false);
  /** Once the hub has reached Running, ignore transient Starting (e.g. Tailscale sidecar or health blips). */
  const hubSteadyRunningRef = useRef(false);

  const checkHealthFallback = useCallback(async () => {
    const port = await fetchFirstHealthyHubPort();
    if (port !== null) {
      client.setConfig({ baseUrl: `http://localhost:${port}`, credentials: 'omit' });
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

  const checkStatus = useCallback(async () => {
    if (checkStatusInFlightRef.current) return;
    checkStatusInFlightRef.current = true;
    try {
      const invoke = getTauriInvoke();
      if (invoke) {
        try {
          const result = (await invoke('get_hub_status_command')) as HubStatusResponse;

          if (isWindows) {
            if (result === 'DockerNotAvailable') {
              shouldAutoStartWindowsHubRef.current = true;
            } else if (result === 'Running' || result === 'Starting' || (typeof result === 'object' && 'Error' in result)) {
              shouldAutoStartWindowsHubRef.current = false;
            } else if (result === 'Stopped' && shouldAutoStartWindowsHubRef.current) {
              shouldAutoStartWindowsHubRef.current = false;
              await startHub('Failed to auto-start hub:');
              return;
            }
          }

          // When running in Tauri release builds, verify the HTTP endpoints
          // are actually reachable before declaring 'Running'. This avoids a
          // flicker where children mount briefly then hide again when the
          // health-check fails.
          // Match Docker's ci-os-hub healthcheck (`/api/health` only — not `/api/registration/status`,
          // which can lag right after boot and wedge the loading UI).
          if (result !== 'Running' && !(result === 'Starting' && hubSteadyRunningRef.current)) {
            sawNonRunningRef.current = true;
          }

          if (result === 'Running' && isTauriRelease) {
            const alivePort = await fetchFirstHealthyHubPort();
            if (alivePort !== null) {
              client.setConfig({ baseUrl: `http://localhost:${alivePort}`, credentials: 'omit' });
            }
            setStatus(alivePort === null ? 'Starting' : 'Running');
          } else {
            setStatus(result);
          }
        } catch {
          await checkHealthFallback();
        }
      } else if (isTauri) {
        await checkHealthFallback();
      }
    } finally {
      checkStatusInFlightRef.current = false;
    }
  }, [isTauri, isTauriRelease, isWindows, checkHealthFallback, startHub]);

  // Track elapsed seconds while in Starting state
  useEffect(() => {
    if (status === 'Running') {
      hubSteadyRunningRef.current = true;
    } else if (status === 'Stopped' || status === 'DockerNotAvailable' || (typeof status === 'object' && status !== null && 'Error' in status)) {
      hubSteadyRunningRef.current = false;
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
    await startHub('Failed to start hub:');
  }, [startHub]);

  const handleRestartHub = useCallback(async () => {
    shouldAutoStartWindowsHubRef.current = false;
    await startHub('Failed to restart hub:');
  }, [startHub]);

  // When the Hub transitions from a non-running state to Running, route loaders
  // that failed during startup (backend wasn't ready) would stay stale in React
  // Router's cache. Reload once so clientLoader runs against the healthy backend.
  useEffect(() => {
    if (isTauri && status === 'Running' && sawNonRunningRef.current && !hasReloadedRef.current) {
      hasReloadedRef.current = true;
      try {
        reloadCurrentWindow();
      } catch {
        // JSDOM in tests doesn't support navigation; ignore safely.
      }
    }
  }, [status, isTauri]);

  const handleViewLogs = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    try {
      const logContent = (await invoke('read_desktop_logs_command')) as string;
      setLogs(logContent);
      setShowLogs(true);
    } catch {
      // Fallback: open the logs directory instead
      try {
        await invoke('open_logs_dir_command');
      } catch {
        // ignore
      }
    }
  }, []);

  const handleOpenLogsDir = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    try {
      await invoke('open_logs_dir_command');
    } catch {
      // ignore
    }
  }, []);

  // If not in Tauri, don't block the UI — web users have the backend proxied
  if (!isTauri) return <>{children}</>;

  // Dark placeholder while the first hub status poll runs (avoids blank flash)
  if (status === null) {
    return (
      <SetupPageShell title="Companion Hub" contentClassName="items-center">
        <div className="flex justify-center py-16" role="status" aria-busy="true" aria-label="Checking hub status">
          <svg
            className="h-8 w-8 animate-spin text-primary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            role="img"
            aria-label="Loading"
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

  const gateTitle = status === 'DockerNotAvailable' ? 'Set Up Your Hub' : 'Companion Hub';

  return (
    <SetupPageShell title={gateTitle} contentClassName="items-center">
      <div className="flex flex-col items-center gap-6 w-full">
        {status === 'DockerNotAvailable' && <DockerInstallGuide />}

        {status === 'Stopped' && (
          <SetupCard className="max-w-md w-full text-center">
            <h2 className="text-xl font-semibold text-foreground mb-2">Hub Not Running</h2>
            <p className="text-muted-foreground mb-6">The Companion Hub backend is not running.</p>
            <button
              type="button"
              onClick={handleStartHub}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Start Hub
            </button>
            <div className="flex gap-4 justify-center mt-6">
              <button type="button" onClick={handleViewLogs} className="text-sm text-muted-foreground underline hover:text-foreground">
                View Logs
              </button>
              <button type="button" onClick={handleOpenLogsDir} className="text-sm text-muted-foreground underline hover:text-foreground">
                Open Logs Folder
              </button>
            </div>
          </SetupCard>
        )}

        {status === 'Starting' && <StartupScreen elapsedSeconds={startupElapsed} />}

        {errorMessage && (
          <SetupCard className="max-w-md w-full text-center">
            <h2 className="text-xl font-semibold text-foreground mb-2">Hub Error</h2>
            <p className="text-muted-foreground mb-6">{errorMessage}</p>
            <button
              type="button"
              onClick={handleRestartHub}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Restart Hub
            </button>
            <div className="flex gap-4 justify-center mt-6">
              <button type="button" onClick={handleViewLogs} className="text-sm text-muted-foreground underline hover:text-foreground">
                View Logs
              </button>
              <button type="button" onClick={handleOpenLogsDir} className="text-sm text-muted-foreground underline hover:text-foreground">
                Open Logs Folder
              </button>
            </div>
          </SetupCard>
        )}

        {status !== 'Starting' && status !== 'DockerNotAvailable' && !errorMessage && (
          <button type="button" onClick={() => checkStatus()} className="text-sm text-muted-foreground underline hover:text-foreground">
            Check again
          </button>
        )}

        {showLogs && logs !== null && (
          <div className="w-full max-w-2xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Recent Logs</span>
              <button type="button" onClick={() => setShowLogs(false)} className="text-sm text-muted-foreground underline hover:text-foreground">
                Hide
              </button>
            </div>
            <pre className="bg-muted rounded-md p-3 text-xs font-mono text-muted-foreground max-h-64 overflow-auto whitespace-pre-wrap">
              {logs || 'No logs available.'}
            </pre>
          </div>
        )}
      </div>
    </SetupPageShell>
  );
}
