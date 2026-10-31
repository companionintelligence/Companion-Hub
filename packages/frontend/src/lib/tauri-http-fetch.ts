import type { FetchLike } from './runtime-fetch';

/** Load Tauri's native HTTP fetch only when a mobile Hub connection needs it. */
export async function loadTauriHttpFetch(): Promise<FetchLike | null> {
  try {
    const http = await import('@tauri-apps/plugin-http');
    return http.fetch as unknown as FetchLike;
  } catch {
    return null;
  }
}
