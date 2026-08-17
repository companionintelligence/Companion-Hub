import { client } from '@/api-client/client.gen';
import { usesCrossOriginDesktopApi } from '@/lib/hub-runtime-mode';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

/** Docker / packaged desktop Hub API. */
export const DOCKER_HUB_API_PORT = 5002;
/** `pnpm run local` Nest API. */
export const LOCAL_SOURCE_DEV_API_PORT = 5004;
/** Vite frontend for `pnpm run local` / `local:desktop`. Not an API port. */
export const LOCAL_SOURCE_DEV_FRONTEND_PORT = 5005;

/** Hub listens on 5002 (Docker / desktop) or 5004 (local source dev). */
export const TAURI_HUB_HEALTH_PROBE_PORTS = [DOCKER_HUB_API_PORT, LOCAL_SOURCE_DEV_API_PORT] as const;
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

/** Vite `:5005` already proxies `/api` to the source Nest. Do not re-point the client. */
export function isViteLocalFrontend(port = Number(window.location.port)): boolean {
  return port === LOCAL_SOURCE_DEV_FRONTEND_PORT;
}

function healthProbePorts(): number[] {
  const currentPort = Number(window.location.port);
  // Vite on :5005 is the UI, not the API. Prefer the source Nest process on
  // :5004 so a leftover Docker Hub on :5002 cannot steal Featured and other
  // new routes.
  if (currentPort === LOCAL_SOURCE_DEV_FRONTEND_PORT) {
    return [LOCAL_SOURCE_DEV_API_PORT, DOCKER_HUB_API_PORT];
  }
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
  // Vite already proxies `/api` to Nest. A same-origin probe avoids CORS to
  // `127.0.0.1:5004` from `localhost:5005`, which used to miss a healthy API
  // and leave the desktop gate on "Connecting to local API...".
  if (typeof window !== 'undefined' && isViteLocalFrontend()) {
    try {
      const res = await fetch('/api/health/live', {
        signal: AbortSignal.timeout(TAURI_HUB_HEALTH_PROBE_MS),
      });
      if (res.ok) return LOCAL_SOURCE_DEV_API_PORT;
    } catch {
      // fall through to the absolute-port sweep
    }
  }

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
    configureHubApiPort(port);
  }
  return port;
}

export function configureHubApiPort(port: number): void {
  // `local:desktop` / `pnpm run local` serve the UI on :5005 and proxy `/api` to
  // :5004. Binding the client to :5004 (or a leftover Docker Hub on :5002) makes
  // every call cross-origin, drops the :5005 session cookie, and a 401 then
  // `location.assign('/login')` — the "Connecting to local API..." flash.
  if (isViteLocalFrontend()) {
    if (client.getConfig().baseUrl) {
      client.setConfig({ baseUrl: '', credentials: 'include' });
    }
    return;
  }

  client.setConfig({
    baseUrl: `http://${LOCAL_HUB_API_HOST}:${port}`,
    credentials: usesCrossOriginDesktopApi() ? 'omit' : 'include',
  });
}
