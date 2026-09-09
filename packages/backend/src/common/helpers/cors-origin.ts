/**
 * Which browser origins may make CREDENTIALED requests to this API.
 *
 * In its own module rather than in `main.ts` so the decision can be tested
 * without importing the bootstrap, which reads the environment and exits.
 */
/** `http://localhost:<port>` / `http://127.0.0.1:<port>`, and nothing else. */
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d+)$/;

/** Matches `main.ts`, which listens on `API_PORT || 3000`. */
const DEFAULT_API_PORT = '3000';
/**
 * Matches `packages/frontend/vite.config.ts`, whose dev server and preview
 * server both listen on `FRONTEND_PORT || 5005` — the same port
 * `packages/desktop/src-tauri/tauri.conf.json` names as its `devUrl`.
 */
const DEFAULT_FRONTEND_PORT = '5005';

/**
 * The loopback ports the HUB is served from — not every port on the machine.
 *
 * The Vite dev server is included only outside production, where it is what an
 * operator actually browses to; in production the frontend is served by the API
 * itself and there is no second port.
 */
function isAllowedLoopbackPort(port: string): boolean {
  if (port === (process.env.API_PORT?.trim() || DEFAULT_API_PORT)) {
    return true;
  }

  return process.env.NODE_ENV !== 'production' && port === (process.env.FRONTEND_PORT?.trim() || DEFAULT_FRONTEND_PORT);
}

/** Operator-declared additional origins, comma-separated. Exact matches only. */
function isExtraCorsOrigin(origin: string): boolean {
  const declared = process.env.CI_HUB_EXTRA_CORS_ORIGINS?.trim();
  if (!declared) {
    return false;
  }

  return declared.split(',').some((value) => value.trim() === origin);
}

export function resolveAllowedCorsOrigin(origin: string | undefined): string | boolean {
  if (!origin) {
    return true;
  }
  // Tauri webview origins. Windows (WebView2) serves the app from
  // http(s)://tauri.localhost, while Linux (webkit2gtk) and macOS (WKWebView)
  // serve it from the custom-protocol origin tauri://localhost.
  if (origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost' || origin === 'tauri://localhost') {
    return origin;
  }
  /*
   * The operator's own list is checked BEFORE the loopback narrowing below:
   * that narrowing refuses every loopback port it does not recognise, so an
   * escape hatch behind it could never express `http://localhost:<port>` —
   * which is the case an operator most needs it for, since the compose file
   * pins the container's `API_PORT` to 5002 while publishing it on the host as
   * `${API_PORT:-5002}`.
   */
  if (isExtraCorsOrigin(origin)) {
    return origin;
  }
  /*
   * ⚠ ANY LOOPBACK PORT USED TO BE REFLECTED, WITH `credentials: true`.
   *
   * Every installed app that publishes a host port serves a page on
   * `http://localhost:<its port>`, so its own web UI — or anything it renders,
   * or anything that can reach that port — could make credentialed
   * cross-origin requests to this API and read the responses. The operator's
   * session cookie travels, and the whole `AuthGuard` surface answers. An app
   * having a web page is not evidence that it may drive the Hub.
   *
   * Narrowed to the ports the Hub itself is served from: its own API port and
   * the frontend dev server. `CI_HUB_EXTRA_CORS_ORIGINS` is the escape hatch for
   * an operator with a genuine second origin — explicit, and not a wildcard.
   */
  const loopbackPort = LOOPBACK_ORIGIN_PATTERN.exec(origin)?.[1];
  if (loopbackPort !== undefined) {
    return isAllowedLoopbackPort(loopbackPort) ? origin : false;
  }

  const domain = process.env.DOMAIN?.trim();
  if (domain && (origin === `https://${domain}` || origin === `http://${domain}`)) {
    return origin;
  }
  const localDomain = process.env.LOCAL_DOMAIN?.trim();
  if (localDomain && (origin === `https://${localDomain}` || origin === `http://${localDomain}`)) {
    return origin;
  }
  return false;
}
