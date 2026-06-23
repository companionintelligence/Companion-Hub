import { client } from '@/api-client/client.gen';

/** Hub listens on 5002 (Docker / desktop) or 5004 (local source dev). */
export const TAURI_HUB_HEALTH_PROBE_PORTS = [5002, 5004] as const;

const TAURI_HUB_HEALTH_PROBE_MS = 2500;

export function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } })
      .__TAURI_INTERNALS__.invoke;
  }
  return null;
}

export function isTauriReleaseBuild(): boolean {
  return Boolean(getTauriInvoke()) && !window.location.origin.startsWith('http://localhost');
}

async function probeWithFetch(): Promise<number | null> {
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
  return outcomes.find((port) => port !== null) ?? null;
}

async function probeWithTauriInvoke(): Promise<number | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;

  for (const port of TAURI_HUB_HEALTH_PROBE_PORTS) {
    try {
      const ok = await invoke('check_hub_status', { url: `http://localhost:${port}` });
      if (ok === true) return port;
    } catch {
      // try next port
    }
  }
  return null;
}

/** Resolve a reachable local Hub API port and configure the API client when found. */
export async function probeHealthyHubApiPort(configureClient = false): Promise<number | null> {
  const port = isTauriReleaseBuild() ? await probeWithTauriInvoke() : await probeWithFetch();
  if (port !== null && configureClient) {
    client.setConfig({
      baseUrl: `http://localhost:${port}`,
      credentials: isTauriReleaseBuild() ? 'omit' : 'include',
    });
  }
  return port;
}

export function configureHubApiPort(port: number): void {
  client.setConfig({
    baseUrl: `http://localhost:${port}`,
    credentials: isTauriReleaseBuild() ? 'omit' : 'include',
  });
}
