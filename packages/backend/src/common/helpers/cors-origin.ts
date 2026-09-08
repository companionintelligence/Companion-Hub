/**
 * Which browser origins may make CREDENTIALED requests to this API.
 *
 * In its own module rather than in `main.ts` so the decision can be tested
 * without importing the bootstrap, which reads the environment and exits.
 */
/** `http://localhost:<port>` / `http://127.0.0.1:<port>`, and nothing else. */
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

/**
 * The loopback ports the HUB is served from — not every port on the machine.
 *
 * The Vite dev server is included only outside production, where it is what an
 * operator actually browses to; in production the frontend is served by the API
 * itself and there is no second port.
 */
function allowedLoopbackPorts(): Set<string> {
  const ports = new Set([process.env.API_PORT?.trim() || '3000']);

  if (process.env.NODE_ENV !== 'production') {
    ports.add(process.env.FRONTEND_DEV_PORT?.trim() || '5173');
  }

  return ports;
}

/** Operator-declared additional origins, comma-separated. Exact matches only. */
function extraCorsOrigins(): Set<string> {
  return new Set(
    (process.env.CI_HUB_EXTRA_CORS_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
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
  if (LOOPBACK_ORIGIN_PATTERN.test(origin)) {
    const port = origin.slice(origin.lastIndexOf(':') + 1);

    if (allowedLoopbackPorts().has(port)) {
      return origin;
    }

    return false;
  }

  if (extraCorsOrigins().has(origin)) {
    return origin;
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
