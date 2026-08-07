import { client } from '@/api-client/client.gen';
import { usesCrossOriginDesktopApi } from '@/lib/hub-runtime-mode';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

/** Hub listens on 5002 (Docker / desktop) or 5004 (local source dev). */
export const TAURI_HUB_HEALTH_PROBE_PORTS = [5002, 5004] as const;
export const LOCAL_HUB_API_HOST = '127.0.0.1';

const TAURI_HUB_HEALTH_PROBE_MS = 2500;

/**
 * True when the SPA must talk to the API cross-origin (header auth, omit cookies).
 *
 * @deprecated Prefer {@link usesCrossOriginDesktopApi} from `hub-runtime-mode.ts`.
 */
export function isTauriReleaseBuild(): boolean {
  return usesCrossOriginDesktopApi();
}

function healthProbePorts(): number[] {
  const currentPort = Number(window.location.port);
  const ports = Number.isInteger(currentPort) && currentPort > 0 ? [currentPort, ...TAURI_HUB_HEALTH_PROBE_PORTS] : [...TAURI_HUB_HEALTH_PROBE_PORTS];
  return [...new Set(ports)];
}

/**
 * Try candidates in order and stop at the first that answers.
 *
 * Sequential, not parallel: the winner is decided by list order either way, but
 * a parallel sweep also requests every losing port on every poll. `hub-status`
 * polls this every 3s, so on a healthy desktop — where the first candidate is
 * the port already serving the page — that emitted an endless console stream of
 * `ERR_CONNECTION_REFUSED` for ports nothing was ever going to listen on.
 *
 * Each port keeps its own timeout rather than sharing one deadline, so a port
 * that accepts TCP but stalls cannot starve the candidates behind it. That
 * makes the all-ports-stalled worst case additive; connection-refused (the only
 * case that actually recurs) returns immediately, so polling is unaffected.
 */
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
  const crossOrigin = usesCrossOriginDesktopApi();
  const port = crossOrigin ? await probeWithTauriInvoke() : await probeWithFetch();
  if (port !== null && configureClient) {
    client.setConfig({
      baseUrl: `http://${LOCAL_HUB_API_HOST}:${port}`,
      credentials: crossOrigin ? 'omit' : 'include',
    });
  }
  return port;
}

export function configureHubApiPort(port: number): void {
  client.setConfig({
    baseUrl: `http://${LOCAL_HUB_API_HOST}:${port}`,
    credentials: usesCrossOriginDesktopApi() ? 'omit' : 'include',
  });
}
