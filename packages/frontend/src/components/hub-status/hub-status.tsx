import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { client } from '@/api-client/client.gen';

interface HubStatusProps {
  children: ReactNode;
}

export function HubStatus({ children }: HubStatusProps) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isTauriRelease = isTauri && !window.location.origin.startsWith('http://localhost:');

  const checkHealth = useCallback(async () => {
    for (const port of [5002, 3000]) {
      try {
        const res = await fetch(`http://localhost:${port}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          // Ensure the client baseUrl matches the working port
          if (isTauriRelease) {
            client.setConfig({ baseUrl: `http://localhost:${port}`, credentials: 'include' });
          }
          setConnected(true);
          return;
        }
      } catch {
        // try next port
      }
    }
    setConnected(false);
  }, [isTauriRelease]);

  useEffect(() => {
    checkHealth();

    const interval = setInterval(() => {
      checkHealth();
    }, 10000);

    return () => clearInterval(interval);
  }, [checkHealth]);

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
      <p className="text-center max-w-md text-muted-foreground">
        The Companion Hub backend is not reachable. Use the system tray icon to start the Hub.
      </p>
      <button
        type="button"
        onClick={() => {
          setConnected(null);
          checkHealth();
        }}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Check again
      </button>
    </div>
  );
}
