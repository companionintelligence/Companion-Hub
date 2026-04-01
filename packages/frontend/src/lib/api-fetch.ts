import { client } from '@/api-client/client.gen';

/**
 * Wrapper around fetch() that prepends the API client's baseUrl.
 * Use this instead of raw fetch('/api/...') to support Tauri release mode
 * where the frontend origin differs from the backend.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = client.getConfig().baseUrl ?? '';
  return fetch(`${baseUrl}${path}`, { credentials: 'include', ...init });
}
