import { client } from '@/api-client/client.gen';

/** Hub listens on 5002 (Docker / desktop) or 5004 (local source dev). */
export const TAURI_HUB_HEALTH_PROBE_PORTS = [5002, 5004] as const;
export const LOCAL_HUB_API_HOST = '127.0.0.1';

const TAURI_HUB_HEALTH_PROBE_MS = 2500;

export function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } })
      .__TAURI_INTERNALS__.invoke;
  }
  return null;
}

export function isLocalTauriDevOrigin(origin = window.location.origin): boolean {
  return origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
}

export function isTauriReleaseBuild(): boolean {
  return Boolean(getTauriInvoke()) && !isLocalTauriDevOrigin();
}

function healthProbePorts(): number[] {
  const currentPort = Number(window.location.port);
  const ports = Number.isInteger(currentPort) && currentPort > 0 ? [currentPort, ...TAURI_HUB_HEALTH_PROBE_PORTS] : [...TAURI_HUB_HEALTH_PROBE_PORTS];
  return [...new Set(ports)];
}

async function probeWithFetch(): Promise<number | null> {
  for (const port of healthProbePorts()) {
    try {
      const res = await fetch(`http://${LOCAL_HUB_API_HOST}:${port}/api/health/live`, {
        signal: AbortSignal.timeout(TAURI_HUB_HEALTH_PROBE_MS),
      });
      if (res.ok) return port;
    } catch {
      // try next port
    }
  }
  return null;
}

async function probeWithTauriInvoke(): Promise<number | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;

  for (const port of healthProbePorts()) {
    try {
      const ok = await invoke('check_hub_status', { url: `http://${LOCAL_HUB_API_HOST}:${port}` });
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
      baseUrl: `http://${LOCAL_HUB_API_HOST}:${port}`,
      credentials: isTauriReleaseBuild() ? 'omit' : 'include',
    });
  }
  return port;
}

export function configureHubApiPort(port: number): void {
  client.setConfig({
    baseUrl: `http://${LOCAL_HUB_API_HOST}:${port}`,
    credentials: isTauriReleaseBuild() ? 'omit' : 'include',
  });
}
