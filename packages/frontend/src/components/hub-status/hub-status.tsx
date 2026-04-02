import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { client } from '@/api-client/client.gen';

interface HubStatusProps {
  children: ReactNode;
}

// Tauri IPC helper
function getTauriInvoke(): ((cmd: string) => Promise<unknown>) | null {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
  }
  return null;
}

export function HubStatus({ children }: HubStatusProps) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isTauriRelease = isTauri && !window.location.origin.startsWith('http://localhost:');

  const checkHealth = useCallback(async () => {
    for (const port of [5002, 3000]) {
      try {
        const res = await fetch(`http://localhost:${port}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          if (isTauriRelease) {
            client.setConfig({ baseUrl: `http://localhost:${port}`, credentials: 'include' });
          }
          setConnected(true);
          setStarting(false);
          return;
        }
      } catch {
        // try next port
      }
    }
    setConnected(false);
  }, [isTauriRelease]);

  // Check Docker availability on mount (Tauri only)
  useEffect(() => {
    const invoke = getTauriInvoke();
    if (invoke) {
      invoke('check_docker_available')
        .then((available) => {
          setDockerAvailable(available as boolean);
        })
        .catch(() => {
          setDockerAvailable(null);
        });
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, starting ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [checkHealth, starting]);

  const handleStartHub = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setStarting(true);
    try {
      await invoke('start_hub_command');
    } catch (err) {
      console.error('Failed to start hub:', err);
    }
  }, []);

  // While checking initially, show nothing (brief flash)
  if (connected === null) return null;

  // If not in Tauri, don't block the UI — web users have the backend proxied
  if (!isTauri) return <>{children}</>;

  // Hub is connected, render normally
  if (connected) return <>{children}</>;

  // Hub is down — show overlay
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <img src="/icons/favicon-96x96.png" alt="Companion Hub" className="h-16 w-16 opacity-50" />
      <h1 className="text-2xl font-semibold text-foreground">Hub Not Running</h1>

      {dockerAvailable === false ? (
        <p className="text-center max-w-md text-muted-foreground">
          Docker is required but not found. Please{' '}
          <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noopener noreferrer" className="underline text-primary">
            install Docker Desktop
          </a>{' '}
          and try again.
        </p>
      ) : starting ? (
        <>
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
            <span className="text-muted-foreground">Starting Hub…</span>
          </div>
          <p className="text-sm text-muted-foreground">This may take a minute on first launch while images are downloaded.</p>
        </>
      ) : (
        <>
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

      {!starting && dockerAvailable !== false && (
        <button
          type="button"
          onClick={() => {
            setConnected(null);
            checkHealth();
          }}
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          Check again
        </button>
      )}
    </div>
  );
}
