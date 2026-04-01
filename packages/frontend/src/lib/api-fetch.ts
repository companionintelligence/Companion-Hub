import { client } from '@/api-client/client.gen';

// Session ID storage for Tauri release mode (where cookies don't work cross-origin)
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

/**
 * Wrapper around fetch() that prepends the API client's baseUrl.
 * In Tauri release mode, also sends the session ID as a custom header
 * since cross-origin cookies don't work in WebView2 over HTTP.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = client.getConfig().baseUrl ?? '';
  const headers = new Headers(init?.headers);
  const sid = getTauriSessionId();
  if (sid) {
    headers.set('X-CI-Hub-Session', sid);
  }
  return fetch(`${baseUrl}${path}`, { credentials: 'include', ...init, headers });
}
