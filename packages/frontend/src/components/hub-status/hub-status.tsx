import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { client } from '@/api-client/client.gen';

interface HubStatusProps {
  children: ReactNode;
}

type HubStatusResponse = 'DockerNotAvailable' | 'Stopped' | 'Starting' | 'Running' | { Error: { message: string } };

type StartupPhase = 'preparing' | 'pulling_images' | 'starting_services' | 'waiting_health' | 'completed' | 'failed';
type StartupTerminalState = 'success' | 'error';

type HubStartupProgressEvent = {
  session_id: string;
  phase: StartupPhase;
  status_text: string;
  current_item: string | null;
  attempt: number;
  terminal_state: StartupTerminalState | null;
};

const HUB_STARTUP_PROGRESS_EVENT = 'hub-startup-progress';
const STARTUP_SESSION_TIMEOUT_MS = 12 * 60 * 1000;
const STARTUP_EVENT_STALE_TIMEOUT_MS = 120 * 1000;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Return true while a startup progress session should still keep the startup UI active.
 */
function isStartupSessionActive(progressEvent: HubStartupProgressEvent | null, sessionStartedAt: number | null, eventLastSeenAt: number): boolean {
  if (!progressEvent || progressEvent.terminal_state === 'success' || progressEvent.terminal_state === 'error') {
    return false;
  }

  const now = Date.now();
  const age = sessionStartedAt ? now - sessionStartedAt : 0;
  const staleFor = now - eventLastSeenAt;
  return age < STARTUP_SESSION_TIMEOUT_MS && staleFor < STARTUP_EVENT_STALE_TIMEOUT_MS;
}

/**
 * Human-readable label used in the startup progress card.
 */
function getStartupPhaseLabel(phase: StartupPhase): string {
  switch (phase) {
    case 'preparing':
      return 'Preparing startup';
    case 'pulling_images':
      return 'Pulling images';
    case 'starting_services':
      return 'Starting services';
    case 'waiting_health':
      return 'Waiting for health checks';
    case 'completed':
      return 'Startup complete';
    case 'failed':
      return 'Startup failed';
    default:
      return 'Starting';
  }
}

// Tauri IPC helper
function getTauriInvoke(): ((cmd: string) => Promise<unknown>) | null {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
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
  // navigator.userAgentData.architecture is not available in WKWebView/Safari (Tauri's macOS webview)
  // Fall back to checking User-Agent and platform
  try {
    const uad = (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData;
    if (uad?.architecture) return uad.architecture === 'arm';
    // Fallback: check for arm64/aarch64 in UA or assume Apple Silicon on modern Macs
    return /arm64|aarch64/i.test(navigator.userAgent) || /Mac/.test(navigator.platform);
  } catch {
    return true; // Default to Apple Silicon (more common on new Macs)
  }
}

export type DockerDesktopGuidePlatform = 'windows' | 'macos';

export type DockerDesktopGuideContent = {
  platformLabel: string;
  downloadUrl: string;
  manualSteps: string[];
  hint?: string;
};

export function getDockerDesktopGuideContent(platform: DockerDesktopGuidePlatform, appleSilicon: boolean): DockerDesktopGuideContent {
  if (platform === 'windows') {
    return {
      platformLabel: 'Windows',
      downloadUrl: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
      manualSteps: [
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
    manualSteps: [
      'Download Docker Desktop for Mac',
      'Open the .dmg and drag Docker to Applications',
      'Launch Docker Desktop and grant permissions',
      'Come back here — the Hub will start automatically',
    ],
  };
}

interface DockerDesktopGuideProps extends DockerDesktopGuideContent {
  footer?: ReactNode;
  description?: string;
}

function DockerDesktopGuide({ platformLabel, downloadUrl, manualSteps, footer, description }: DockerDesktopGuideProps) {
  return (
    <>
      <h1 className="text-2xl font-semibold text-foreground">Docker Desktop Required</h1>
      <div className="text-center max-w-md text-muted-foreground space-y-3">
        <p>{description ?? 'Companion Hub requires Docker Desktop to run.'}</p>
        <ol className="text-left list-decimal list-inside space-y-1">
          {manualSteps.map((step) => (
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
    return (
      <DockerDesktopGuide
        {...guide}
        description="Download Docker Desktop for your Windows machine. Companion Hub will keep checking and continue automatically once Docker is ready."
        footer={guide.hint ? <p className="text-xs text-muted-foreground/70">{guide.hint}</p> : undefined}
      />
    );
  }

  if (platform === 'macos') {
    const guide = getDockerDesktopGuideContent('macos', isAppleSilicon());
    return <DockerDesktopGuide {...guide} footer={guide.hint ? <p className="text-xs text-muted-foreground/70">{guide.hint}</p> : undefined} />;
  }

  return <LinuxDockerGuide />;
}

export function HubStatus({ children }: HubStatusProps) {
  const [status, setStatus] = useState<HubStatusResponse | null>(null);
  const [startupProgress, setStartupProgress] = useState<HubStartupProgressEvent | null>(null);
  // Mirror of startupProgress state held in a ref so checkStatus can read the
  // current value without including `startupProgress` in its deps array.  If
  // `startupProgress` were listed as a dep, every compose progress event would
  // re-create checkStatus and restart the 3-second poll interval, potentially
  // breaking polling entirely while compose is producing rapid output.
  const startupProgressRef = useRef<HubStartupProgressEvent | null>(null);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isTauriRelease = isTauri && !window.location.origin.startsWith('http://localhost:');
  const isWindows = isTauri && detectPlatform() === 'windows';
  const shouldAutoStartWindowsHubRef = useRef(true);
  const startupSessionStartedAtRef = useRef<number | null>(null);
  const startupEventLastSeenAtRef = useRef(0);

  /**
   * Apply a startup event, update session timestamps, and keep the ref in sync
   * so polling can read the current value without a stale closure.
   */
  const applyStartupProgressEvent = useCallback((event: HubStartupProgressEvent) => {
    setStartupProgress(event);
    startupProgressRef.current = event;
    startupEventLastSeenAtRef.current = Date.now();
    if (!startupSessionStartedAtRef.current || event.phase === 'preparing') {
      startupSessionStartedAtRef.current = Date.now();
    }
  }, []);

  /**
   * Fetch the latest startup progress snapshot from desktop runtime for missed-event recovery.
   * Only called when the hub is not yet running so we avoid repeated IPC round-trips
   * after startup has already succeeded.
   */
  const loadStartupProgressSnapshot = useCallback(
    async (invoke: (cmd: string) => Promise<unknown>, hubResult: string) => {
      // Skip once running — the snapshot stays in desktop global state permanently and
      // would otherwise trigger spurious re-renders after every successful startup.
      if (hubResult === 'Running') return null;
      try {
        const snapshot = (await invoke('get_startup_progress_command')) as HubStartupProgressEvent | null;
        if (snapshot) {
          applyStartupProgressEvent(snapshot);
        }
        return snapshot;
      } catch {
        return null;
      }
    },
    [applyStartupProgressEvent],
  );

  const checkHealthFallback = useCallback(async () => {
    for (const port of [5002, 3000]) {
      try {
        const res = await fetch(`http://localhost:${port}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          setStatus('Running');
          return;
        }
      } catch {
        // try next port
      }
    }
    setStatus('Stopped');
  }, []);

  const startHub = useCallback(
    async (logMessage: string) => {
      const invoke = getTauriInvoke();
      if (!invoke) return false;

      setStatus('Starting');
      const localProgress: HubStartupProgressEvent = {
        session_id: `local-${Date.now()}`,
        phase: 'preparing',
        status_text: 'Preparing startup resources...',
        current_item: null,
        attempt: 1,
        terminal_state: null,
      };
      applyStartupProgressEvent(localProgress);

      try {
        await invoke('start_hub_command');
        return true;
      } catch (err) {
        console.error(logMessage, err);
        setStartupProgress(null);
        startupProgressRef.current = null;
        startupSessionStartedAtRef.current = null;
        setStatus({ Error: { message: getErrorMessage(err) } });
        return false;
      }
    },
    [applyStartupProgressEvent],
  );

  const checkStatus = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (invoke) {
      try {
        const result = (await invoke('get_hub_status_command')) as HubStatusResponse;
        // Use the ref — not the `startupProgress` state — to avoid including
        // `startupProgress` in the checkStatus deps array.  Using state would
        // cause checkStatus to be re-created on every progress event and restart
        // the poll interval, effectively breaking the 3 s poll during startup.
        const startupSnapshot = await loadStartupProgressSnapshot(invoke, typeof result === 'string' ? result : 'Error');
        const effectiveStartup = startupSnapshot ?? startupProgressRef.current;
        const startupActive = isStartupSessionActive(effectiveStartup, startupSessionStartedAtRef.current, startupEventLastSeenAtRef.current);

        if (effectiveStartup?.terminal_state === 'error') {
          setStatus({ Error: { message: effectiveStartup.status_text } });
          return;
        }

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

        // Keep startup progress visible while desktop startup session is active,
        // even if status polling still reports Stopped early in the compose flow.
        if (startupActive && result !== 'Running' && result !== 'DockerNotAvailable') {
          setStatus('Starting');
          return;
        }

        if (!startupActive && effectiveStartup?.terminal_state === 'success') {
          setStartupProgress(null);
          startupProgressRef.current = null;
          startupSessionStartedAtRef.current = null;
        }

        setStatus(result);

        // When running, configure API client for Tauri release builds
        if (result === 'Running' && isTauriRelease) {
          for (const port of [5002, 3000]) {
            try {
              const res = await fetch(`http://localhost:${port}/api/health`, {
                signal: AbortSignal.timeout(2000),
              });
              if (res.ok) {
                client.setConfig({ baseUrl: `http://localhost:${port}`, credentials: 'omit' });
                break;
              }
            } catch {
              // try next port
            }
          }
        }
      } catch {
        await checkHealthFallback();
      }
    } else if (isTauri) {
      // Only probe localhost in Tauri builds — in a regular browser the API
      // is served from the same origin so no localhost probing is needed, and
      // doing so triggers Private Network Access (PNA) CORS errors when the
      // page is loaded from a public/tunnel URL.
      await checkHealthFallback();
    }
  }, [
    isTauri,
    isTauriRelease,
    isWindows,
    checkHealthFallback,
    loadStartupProgressSnapshot,
    startHub,
    // startupProgress intentionally omitted — we read from startupProgressRef
    // to prevent re-creation of this callback (and poll interval restart) on
    // every compose progress event during startup.
  ]);

  useEffect(() => {
    if (!isTauri) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<HubStartupProgressEvent>(HUB_STARTUP_PROGRESS_EVENT, (event) => {
          applyStartupProgressEvent(event.payload);
          if (event.payload.terminal_state === 'success') {
            setStatus('Starting');
          }
          if (event.payload.terminal_state === 'error') {
            setStatus({ Error: { message: event.payload.status_text } });
          }
        });
      } catch {
        // Event bridge unavailable in non-desktop or non-Tauri test contexts.
      }
    })();

    return () => {
      void unlisten?.();
    };
  }, [applyStartupProgressEvent, isTauri]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 3000);
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
        </>
      )}

      {status === 'Starting' && (
        <>
          <h1 className="text-2xl font-semibold text-foreground">Hub Starting…</h1>
          {startupProgress && (
            <div className="text-center max-w-md text-muted-foreground space-y-1">
              <p className="text-sm font-medium text-foreground">{getStartupPhaseLabel(startupProgress.phase)}</p>
              <p className="text-sm">{startupProgress.status_text}</p>
              {startupProgress.current_item && <p className="text-xs text-muted-foreground/80">Current item: {startupProgress.current_item}</p>}
              {startupProgress.attempt > 1 && <p className="text-xs">Retry attempt {startupProgress.attempt}</p>}
            </div>
          )}
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 animate-spin text-primary"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              role="img"
              aria-label="Loading"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-muted-foreground">{startupProgress?.status_text ?? 'Waiting to start…'}</span>
          </div>
          <p className="text-sm text-muted-foreground">This may take a few minutes on first run while images are downloaded.</p>
        </>
      )}

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
        </>
      )}

      {status !== 'Starting' && status !== 'DockerNotAvailable' && !errorMessage && (
        <button type="button" onClick={() => checkStatus()} className="text-sm text-muted-foreground underline hover:text-foreground">
          Check again
        </button>
      )}
    </div>
  );
}
