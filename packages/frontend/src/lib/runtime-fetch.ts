/**
 * Swappable `fetch` used by the API client and {@link ./api-fetch}.
 *
 * On the web and desktop this is just `window.fetch`, so behaviour is identical
 * to before. On mobile, {@link ./mobile-connection} swaps in the Tauri HTTP
 * plugin's `fetch` (native, no webview CORS) so a `tauri://localhost` webview
 * can talk to a remote `https://hub-*.ci.computer` appliance.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

let activeFetch: FetchLike = defaultFetch;

/** Replace the fetch implementation used app-wide (mobile routes through native HTTP). */
export function setActiveFetch(fetcher: FetchLike): void {
  activeFetch = fetcher;
}

/** Restore the default `window.fetch`. */
export function resetActiveFetch(): void {
  activeFetch = defaultFetch;
}

/** The current fetch implementation. Defaults to `window.fetch`. */
export function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return activeFetch(input, init);
}
