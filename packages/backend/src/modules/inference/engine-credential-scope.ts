import type { InferenceBackendType } from '@ci-hub/common/types';

/**
 * Where an engine's API key may be sent, and what an app is handed instead everywhere else.
 *
 * An engine key (a saved vLLM key, VLLM_API_KEY, OMLX_API_KEY, LEMONADE_API_KEY) is the credential
 * for one server. Two paths used to send it wherever a URL pointed. App handouts wrote it into
 * every AI app's env even after pool routing pointed the app at this Hub, which admits apps by
 * origin and never reads the bearer, so the key sat in every app container and data dir for
 * nothing; and with a decode override set, the app sent the vLLM key to the override's server.
 * The Re-check probes sent the saved key to whatever `?url=` they were given, so any caller of
 * those routes could collect it by naming a listener, and an operator re-checking a new server
 * sent it the old server's key. Both now ask the same question: is this URL that engine's own?
 */

/**
 * Placeholder bearers, one per backend. Not secrets: they are what an app sends where nothing
 * checks the bearer (Ollama never does, and neither do this Hub's pool proxy and `/api/inference/v1`
 * for a request from inside the appliance), and OpenAI clients refuse to start with an empty key.
 */
export const BACKEND_API_KEY: Record<InferenceBackendType, string> = {
  ollama: 'ollama',
  vllm: 'vllm',
  lemonade: 'lemonade',
  omlx: 'omlx',
};

/**
 * One server's address in the form every spelling of it shares: scheme, host and port as `URL`
 * reads them (host lower-cased, a default port dropped), and the path without trailing slashes or
 * one trailing `/v1`, the suffix an operator pastes out of an OpenAI client config. Query, fragment
 * and userinfo do not change which server receives a request, so they are left out. `null` for
 * anything that is not an http(s) URL, and `null` matches nothing, so an unparseable URL is never
 * taken for the engine's own.
 */
export function serverIdentity(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** Whether `a` and `b` address the same server by {@link serverIdentity}. */
export function isSameServer(a: string | null | undefined, b: string | null | undefined): boolean {
  const identity = serverIdentity(a);
  return identity !== null && identity === serverIdentity(b);
}

/**
 * The bearer an app should send to `endpointUrl`, the URL it is actually handed after pool routing
 * and any decode override: the engine's key only when that URL is the engine itself, and the
 * backend's placeholder otherwise.
 *
 * That covers the pool proxy (routed or `poolRouteAppsAlways`), `/api/inference/v1`, and a decode
 * override on another server, which the Hub holds no key for. An override that names the engine's
 * own URL keeps the key, since it is the same server.
 */
export function appBearerFor(options: {
  endpointUrl: string | null | undefined;
  backendType: InferenceBackendType;
  engineUrl: string;
  engineKey: string | null | undefined;
}): string {
  const key = options.engineKey?.trim();
  return key && isSameServer(options.endpointUrl, options.engineUrl) ? key : BACKEND_API_KEY[options.backendType];
}
