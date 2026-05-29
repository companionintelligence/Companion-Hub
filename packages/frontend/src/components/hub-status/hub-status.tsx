import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { client } from '@/api-client/client.gen';

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

function DockerDesktopGuide({
  platformLabel,
  downloadUrl,
  alreadyInstalledTitle,
  alreadyInstalledSteps,
  notInstalledTitle,
  notInstalledSteps,
  footer,
}: DockerDesktopGuideProps) {
  return (
    <>
      <h1 className="text-2xl font-semibold text-foreground">Docker Desktop Required</h1>
      <div className="text-center max-w-md text-muted-foreground space-y-3">
        <p>Docker Desktop is either not installed or not currently running.</p>
        <p>Companion Hub needs Docker Desktop to run your apps and services.</p>
        <p>We&apos;ll automatically detect when Docker is ready and continue setup automatically.</p>
        <p className="text-left font-medium text-foreground">{alreadyInstalledTitle}</p>
        <ol className="text-left list-decimal list-inside space-y-1">
          {alreadyInstalledSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-left font-medium text-foreground">{notInstalledTitle}</p>
        <ol className="text-left list-decimal list-inside space-y-1">
          {notInstalledSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Download Docker Desktop for {platformLabel}
        </a>
        {footer}
      </div>
    </>
  );
}

function LinuxDockerGuide() {
  return (
    <>
      <h1 className="text-2xl font-semibold text-foreground">Docker Engine Required</h1>
      <div className="text-center max-w-md text-muted-foreground space-y-3">
        <p>Companion Hub requires Docker to run.</p>
        <ol className="text-left list-decimal list-inside space-y-1">
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
          className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          View Docker Install Guide
        </a>
      </div>
    </>
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
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="flex items-center gap-2.5">
        <span className={`text-sm font-medium tabular-nums ${color} ${service.state === 'starting' ? 'animate-pulse' : ''}`}>
          {SERVICE_ICON[service.state]}
        </span>
        <span className="text-sm text-foreground">{service.label}</span>
      </div>
      <span className={`text-xs tabular-nums ${color}`}>{SERVICE_LABEL[service.state]}</span>
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
    <div className="flex flex-col items-center gap-6 w-full max-w-sm">
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">Starting Companion Hub</h1>
        <p className="text-sm text-muted-foreground">
          {showVerySlowMessage
            ? 'Still working — Docker images may be downloading for the first time.'
            : showSlowMessage
              ? 'Almost there — some services are taking longer than usual.'
              : 'Services are coming online…'}
        </p>
        <p className="text-xs text-muted-foreground/80">This might take a minute on first startup while containers are pulled.</p>
      </div>

      {/* Progress bar */}
      <div className="w-full space-y-1.5">
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-all duration-700 ease-out" style={{ width: `${Math.max(pct, 4)}%` }} />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground/60 tabular-nums">
          <span>{pct}%</span>
          <span>{elapsed} elapsed</span>
        </div>
        {progress && (
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground/70">
              {serviceCounts.ready} ready, {serviceCounts.starting} starting, {serviceCounts.pending} pending
              {serviceCounts.failed > 0 ? `, ${serviceCounts.failed} failed` : ''}
            </div>
            <div className="text-xs text-muted-foreground/70">
              Image pulls: {progress.image_pulled}/{progress.image_total} ({progress.image_pull_pct}%)
            </div>
          </div>
        )}
      </div>

      {/* Per-service list */}
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
          if (result !== 'Running') {
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
        window.location.reload();
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

  // While checking initially, show nothing (brief flash)
  if (status === null) return null;

  // Hub is running, render normally
  if (status === 'Running') return <>{children}</>;

  // Error message extraction
  const errorMessage = typeof status === 'object' && 'Error' in status ? status.Error.message : null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <img src="/icons/favicon-96x96.png" alt="Companion Hub" className="h-16 w-16 opacity-50" />

      {status === 'DockerNotAvailable' && <DockerInstallGuide />}

      {status === 'Stopped' && (
        <>
          <h1 className="text-2xl font-semibold text-foreground">Hub Not Running</h1>
          <p className="text-center max-w-md text-muted-foreground">The Companion Hub backend is not running.</p>
          <button
            type="button"
            onClick={handleStartHub}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Start Hub
          </button>
          <div className="flex gap-4">
            <button type="button" onClick={handleViewLogs} className="text-sm text-muted-foreground underline hover:text-foreground">
              View Logs
            </button>
            <button type="button" onClick={handleOpenLogsDir} className="text-sm text-muted-foreground underline hover:text-foreground">
              Open Logs Folder
            </button>
          </div>
        </>
      )}

      {status === 'Starting' && <StartupScreen elapsedSeconds={startupElapsed} />}

      {errorMessage && (
        <>
          <h1 className="text-2xl font-semibold text-foreground">Hub Error</h1>
          <p className="text-center max-w-md text-muted-foreground">{errorMessage}</p>
          <button
            type="button"
            onClick={handleRestartHub}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Restart Hub
          </button>
          <div className="flex gap-4">
            <button type="button" onClick={handleViewLogs} className="text-sm text-muted-foreground underline hover:text-foreground">
              View Logs
            </button>
            <button type="button" onClick={handleOpenLogsDir} className="text-sm text-muted-foreground underline hover:text-foreground">
              Open Logs Folder
            </button>
          </div>
        </>
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
  );
}
