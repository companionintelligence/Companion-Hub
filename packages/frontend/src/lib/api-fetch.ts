import { client } from '@/api-client/client.gen';

// Session ID storage for Tauri modes (where cookies don't work cross-origin)
let tauriSessionId: string | null = null;

export function setTauriSessionId(id: string | null) {
  tauriSessionId = id;
  if (id) {
    sessionStorage.setItem('ci-hub-session', id);
  } else {
    sessionStorage.removeItem('ci-hub-session');
  }
}

export function getTauriSessionId(): string | null {
  if (tauriSessionId) return tauriSessionId;
  tauriSessionId = sessionStorage.getItem('ci-hub-session');
  return tauriSessionId;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Wrapper around fetch() that prepends the API client's baseUrl.
 * In Tauri modes, sends the session ID as a custom header since
 * cross-origin cookies don't work when the server uses Access-Control-Allow-Origin: *.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = client.getConfig().baseUrl ?? '';
  const headers = new Headers(init?.headers);
  const sid = getTauriSessionId();
  if (sid) {
    headers.set('X-CI-Hub-Session', sid);
  }
  const credentials: RequestCredentials = isTauri ? 'omit' : 'include';
  return fetch(`${baseUrl}${path}`, { credentials, ...init, headers });
}
