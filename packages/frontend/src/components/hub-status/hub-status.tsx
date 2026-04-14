import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { client } from '@/api-client/client.gen';

interface HubStatusProps {
  children: ReactNode;
}

type HubStatusResponse = 'DockerNotAvailable' | 'Stopped' | 'Starting' | 'Running' | { Error: { message: string } };

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

type DockerInstallState = 'idle' | 'installing' | 'success' | 'error' | 'needs-logout' | 'starting-daemon';
type DockerAccessState = 'available' | 'permission_denied' | 'daemon_unavailable' | 'not_installed' | 'error';

type DockerAccessCheck = {
  state: DockerAccessState;
  detail?: string | null;
};

const POST_INSTALL_POLL_ATTEMPTS = 15;
const POST_INSTALL_POLL_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function pollDockerAccess(
  invoke: (cmd: string) => Promise<unknown>,
  options?: {
    attempts?: number;
    delayMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<DockerAccessCheck> {
  const attempts = options?.attempts ?? POST_INSTALL_POLL_ATTEMPTS;
  const delayMs = options?.delayMs ?? POST_INSTALL_POLL_DELAY_MS;
  const sleepFn = options?.sleepFn ?? sleep;

  let lastResult: DockerAccessCheck = {
    state: 'error',
    detail: 'Docker did not become ready after installation.',
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = (await invoke('check_docker_access_command')) as DockerAccessCheck;
    lastResult = result;

    if (result.state === 'available' || result.state === 'permission_denied' || result.state === 'error') {
      return result;
    }

    if (attempt < attempts - 1) {
      await sleepFn(delayMs);
    }
  }

  return lastResult;
}

function LinuxDockerInstall() {
  const [installState, setInstallState] = useState<DockerInstallState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const invoke = getTauriInvoke();

  const applyPostInstallAccessState = useCallback((dockerAccess: DockerAccessCheck) => {
    if (dockerAccess.state === 'available') {
      setInstallState('success');
      return;
    }

    if (dockerAccess.state === 'permission_denied') {
      setInstallState('needs-logout');
      return;
    }

    if (dockerAccess.state === 'daemon_unavailable') {
      setErrorMessage(dockerAccess.detail ?? 'Docker was installed, but the daemon is still starting. Wait a moment, then check again.');
      setInstallState('starting-daemon');
      return;
    }

    if (dockerAccess.state === 'not_installed') {
      setErrorMessage(
        dockerAccess.detail ??
          'Docker install completed, but the Docker CLI is still unavailable. Install Docker manually or try the installer again.',
      );
      setInstallState('error');
      return;
    }

    setErrorMessage(dockerAccess.detail ?? 'Docker installation did not complete successfully.');
    setInstallState('error');
  }, []);

  const checkPostInstallAccess = useCallback(async () => {
    if (!invoke) return;

    try {
      const dockerAccess = await pollDockerAccess(invoke);
      applyPostInstallAccessState(dockerAccess);
    } catch (err) {
      setErrorMessage(getErrorMessage(err));
      setInstallState('error');
    }
  }, [applyPostInstallAccessState, invoke]);

  const handleInstall = useCallback(async () => {
    if (!invoke) return;
    setInstallState('installing');
    setErrorMessage(null);
    try {
      await invoke('install_docker_linux');
      await checkPostInstallAccess();
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes('cancelled') || msg.includes('Authorization')) {
        setInstallState('idle');
      } else {
        setErrorMessage(msg);
        setInstallState('error');
      }
    }
  }, [checkPostInstallAccess, invoke]);

  if (installState === 'installing') {
    return (
      <>
        <h1 className="text-2xl font-semibold text-foreground">Installing Docker\u2026</h1>
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
          <span className="text-muted-foreground">This may take a minute. You will be prompted for your password.</span>
        </div>
      </>
    );
  }

  if (installState === 'success') {
    return (
      <>
        <h1 className="text-2xl font-semibold text-foreground">Docker Installed!</h1>
        <p className="text-muted-foreground">Docker is ready. The Hub will start automatically.</p>
      </>
    );
  }

  if (installState === 'needs-logout') {
    return (
      <>
        <h1 className="text-2xl font-semibold text-foreground">Almost There</h1>
        <div className="text-center max-w-md text-muted-foreground space-y-3">
          <p>Docker has been installed, but you need to log out and back in for group permissions to take effect.</p>
          <p className="text-sm">After logging back in, restart this application.</p>
        </div>
      </>
    );
  }

  if (installState === 'starting-daemon') {
    return (
      <>
        <h1 className="text-2xl font-semibold text-foreground">Docker Installed — Finishing Startup</h1>
        <div className="text-center max-w-md text-muted-foreground space-y-3">
          <p>Docker was installed successfully, but the daemon is still starting.</p>
          <p className="text-sm">Wait a moment, then check again. If this keeps happening, try restarting Docker or your machine.</p>
          {errorMessage && <p className="text-xs break-words">{errorMessage}</p>}
        </div>
        <button
          type="button"
          onClick={checkPostInstallAccess}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Check Again
        </button>
      </>
    );
  }

  if (installState === 'error') {
    return (
      <>
        <h1 className="text-2xl font-semibold text-foreground">Installation Failed</h1>
        <p className="text-center max-w-md text-muted-foreground">{errorMessage}</p>
        <button
          type="button"
          onClick={handleInstall}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try Again
        </button>
        <div className="text-center max-w-md text-muted-foreground mt-4 space-y-2">
          <p className="text-xs">Or install manually:</p>
          <div className="text-left bg-muted rounded-md p-3 text-xs font-mono">
            <p>curl -fsSL https://get.docker.com | sh</p>
            <p>sudo usermod -aG docker $USER</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold text-foreground">Docker Engine Required</h1>
      <div className="text-center max-w-md text-muted-foreground space-y-3">
        <p>Companion Hub requires Docker to run containers. We can install it for you automatically.</p>
        {invoke ? (
          <button
            type="button"
            onClick={handleInstall}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Install Docker
          </button>
        ) : (
          <div className="text-left bg-muted rounded-md p-3 text-sm font-mono">
            <p>curl -fsSL https://get.docker.com | sh</p>
            <p>sudo usermod -aG docker $USER</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground/70">You will be prompted for your password. This installs Docker Engine (not Docker Desktop).</p>
        <a
          href="https://docs.docker.com/engine/install/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground/70 underline hover:text-foreground"
        >
          Prefer to install manually?
        </a>
      </div>
    </>
  );
}

function DockerInstallGuide() {
  const platform = detectPlatform();

  if (platform === 'windows') {
    return (
      <>
        <h1 className="text-2xl font-semibold text-foreground">Docker Desktop Required</h1>
        <div className="text-center max-w-md text-muted-foreground space-y-3">
          <p>Companion Hub requires Docker Desktop to run.</p>
          <ol className="text-left list-decimal list-inside space-y-1">
            <li>Download Docker Desktop for Windows</li>
            <li>Run the installer and follow the prompts</li>
            <li>Restart your computer if prompted</li>
            <li>Start Docker Desktop</li>
            <li>Come back here — the Hub will start automatically</li>
          </ol>
          <a
            href="https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Download Docker Desktop
          </a>
          <p className="text-xs text-muted-foreground/70">
            Docker Desktop requires Windows 10/11 with WSL2 enabled. If you see &quot;WSL2 is not installed&quot;, run{' '}
            <code className="bg-muted px-1 rounded">wsl --install</code> in PowerShell as admin.
          </p>
        </div>
      </>
    );
  }

  if (platform === 'macos') {
    const dmgUrl = isAppleSilicon() ? 'https://desktop.docker.com/mac/main/arm64/Docker.dmg' : 'https://desktop.docker.com/mac/main/amd64/Docker.dmg';
    return (
      <>
        <h1 className="text-2xl font-semibold text-foreground">Docker Desktop Required</h1>
        <div className="text-center max-w-md text-muted-foreground space-y-3">
          <p>Companion Hub requires Docker Desktop to run.</p>
          <ol className="text-left list-decimal list-inside space-y-1">
            <li>Download Docker Desktop for Mac</li>
            <li>Open the .dmg and drag Docker to Applications</li>
            <li>Launch Docker Desktop and grant permissions</li>
            <li>Come back here — the Hub will start automatically</li>
          </ol>
          <a
            href={dmgUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Download Docker Desktop
          </a>
        </div>
      </>
    );
  }

  // Linux — automatic install via Tauri IPC
  return <LinuxDockerInstall />;
}

export function HubStatus({ children }: HubStatusProps) {
  const [status, setStatus] = useState<HubStatusResponse | null>(null);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isTauriRelease = isTauri && !window.location.origin.startsWith('http://localhost:');

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

  const checkStatus = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (invoke) {
      try {
        const result = (await invoke('get_hub_status_command')) as HubStatusResponse;
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
  }, [isTauri, isTauriRelease, checkHealthFallback]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 3000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handleStartHub = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setStatus('Starting');
    try {
      await invoke('start_hub_command');
    } catch (err) {
      console.error('Failed to start hub:', err);
    }
  }, []);

  const handleRestartHub = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setStatus('Starting');
    try {
      // stop then start
      await invoke('start_hub_command');
    } catch (err) {
      console.error('Failed to restart hub:', err);
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
        </>
      )}

      {status === 'Starting' && (
        <>
          <h1 className="text-2xl font-semibold text-foreground">Hub Starting…</h1>
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
            <span className="text-muted-foreground">Waiting for Hub to become healthy…</span>
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
