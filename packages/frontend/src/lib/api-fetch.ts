import { client } from '@/api-client/client.gen';

/**
 * Detect Tauri release mode: the origin will be http://tauri.localhost or similar,
 * not a standard http://localhost:PORT dev server.
 */
const isTauriRelease = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !window.location.origin.startsWith('http://localhost:');

/**
 * Wrapper around fetch() that prepends the API client's baseUrl.
 * Use this instead of raw fetch('/api/...') to support Tauri release mode
 * where the frontend origin differs from the backend.
 *
 * In Tauri release mode, credentials are always 'omit' because cross-origin
 * requests with credentials:'include' are blocked when the server responds
 * with Access-Control-Allow-Origin: *.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = client.getConfig().baseUrl ?? '';
  const credentials: RequestCredentials = isTauriRelease ? 'omit' : (init?.credentials ?? 'include');
  return fetch(`${baseUrl}${path}`, { ...init, credentials });
}
