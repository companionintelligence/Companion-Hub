import type { AppStatus } from '@/core/database/drizzle/types';

/**
 * The page Traefik shows in place of its bare 502 or 504 when an app does not answer, most often a
 * 502 because it is still starting (CI-Hub#1764). Never for a 503, which apps send on purpose; see
 * `ci-hub-app-starting` in dynamic.yml.
 *
 * Traefik fetches it through the `ci-hub-app-starting` errors middleware in
 * assets/traefik/dynamic/dynamic.yml, which every app router ends with. It sends the visitor's own
 * request headers along, `Host` included, and answers the visitor with this page's body under the
 * app's original status code, so API clients and health checks still see the failure.
 *
 * Self-contained by necessity: it is served at the app's address, where a relative link to a
 * stylesheet or an icon would ask the app that just failed. No scripts either; the page reloads
 * itself with a meta refresh.
 */

/** The path Traefik asks for. The `query` of `ci-hub-app-starting` in dynamic.yml must start with it. */
export const APP_STARTING_PAGE_PATH = '/api/apps/starting';

/** Seconds between reloads while an app is starting, also sent as `Retry-After`. */
export const APP_STARTING_RELOAD_SECONDS = 5;

/**
 * How long after an app last changed state, or after the Hub itself started, a gateway error still
 * reads as "starting". `running` means the containers are up, not that the app inside listens yet,
 * and after a reboot Docker starts every app alongside the Hub without the Hub recording a start.
 */
export const RECENTLY_STARTED_MS = 2 * 60_000;

/** The status codes this page stands in for. Anything else asked for gets {@link DEFAULT_PAGE_STATUS}. */
const GATEWAY_ERROR_STATUSES: ReadonlySet<number> = new Set([502, 504]);
/** What Traefik answers while an app starts. Traefik sends the app's own code to the visitor anyway. */
const DEFAULT_PAGE_STATUS = 502;

/** States the app comes back from by itself, without anyone pressing Start. */
const COMING_BACK_STATUSES: ReadonlySet<AppStatus> = new Set([
  'installing',
  'starting',
  'restarting',
  'updating',
  'resetting',
  'backing_up',
  'restoring',
]);
const STOPPED_STATUSES: ReadonlySet<AppStatus> = new Set(['stopped', 'stopping']);

export type AppStartingPageState = 'starting' | 'stopped' | 'not_responding' | 'unknown';

export interface AppStartingPage {
  state: AppStartingPageState;
  /** The app's display name. Absent when the host matched no app. */
  appName?: string;
  /**
   * Where the page's button goes: the app's page in the Hub, or the Hub's home for a host that
   * matched no app. Null when the Hub has no public address to link to.
   */
  hubUrl?: string | null;
}

/**
 * Which page an app gets. `changedAtMs` is when its row last changed, which for a `running` app is
 * when it was last started unless something else about it was edited since.
 *
 * `hubStartsIt` is false for a port-expose app: the Hub routes to a port the person runs
 * themselves and never starts it, so "starting" would be a guess.
 */
export function classifyApp(input: {
  status: AppStatus;
  changedAtMs: number | null;
  hubStartedAtMs: number;
  nowMs: number;
  hubStartsIt: boolean;
}): Exclude<AppStartingPageState, 'unknown'> {
  if (COMING_BACK_STATUSES.has(input.status)) {
    return 'starting';
  }
  if (STOPPED_STATUSES.has(input.status)) {
    return 'stopped';
  }

  const recently = (atMs: number | null) => atMs !== null && Number.isFinite(atMs) && input.nowMs >= atMs && input.nowMs - atMs < RECENTLY_STARTED_MS;
  if (input.status === 'running' && input.hubStartsIt && (recently(input.changedAtMs) || recently(input.hubStartedAtMs))) {
    return 'starting';
  }

  return 'not_responding';
}

/** The status code Traefik asked about (`?status={status}`), or 502 for anything else. */
export function appStartingPageStatus(requested: unknown): number {
  const raw = Array.isArray(requested) ? requested[0] : requested;
  const status = typeof raw === 'string' && /^\d{3}$/.test(raw) ? Number(raw) : Number.NaN;
  return GATEWAY_ERROR_STATUSES.has(status) ? status : DEFAULT_PAGE_STATUS;
}

/**
 * Response headers for the page. Traefik copies every one of them onto the visitor's response.
 *
 * `no-store` because the page stands at the app's own URL and must never be what a cache serves
 * for it later. The policy allows the inline styles and nothing else, so even a name that slipped
 * past the escaping could not run.
 */
export function appStartingPageHeaders(page: AppStartingPage): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(page.state === 'starting' ? { 'Retry-After': String(APP_STARTING_RELOAD_SECONDS) } : {}),
  };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Safe in text and in a quoted attribute alike. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** An app's name as one line: manifests and port-expose names are written by someone else. */
function displayName(name: string | undefined): string {
  return name?.replace(/\s+/g, ' ').trim() || 'This app';
}

/** Only an absolute http(s) address the Hub built itself becomes a link. */
function linkTarget(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

interface PageCopy {
  title: string;
  body: string;
  button?: string;
  reload: boolean;
}

function copyFor(page: AppStartingPage): PageCopy {
  const name = displayName(page.appName);
  switch (page.state) {
    case 'starting':
      return {
        title: `${name} is starting…`,
        body: `It usually takes a few seconds. This page reloads by itself and opens ${name} as soon as it's ready.`,
        reload: true,
      };
    case 'stopped':
      return {
        title: `${name} is stopped`,
        body: 'Start it in Companion Hub, then reload this page.',
        button: 'Open Companion Hub',
        reload: false,
      };
    case 'not_responding':
      return {
        title: `${name} isn't responding`,
        body: "It didn't answer this time. Check on it in Companion Hub, then reload this page.",
        button: `Open ${name} in Companion Hub`,
        reload: false,
      };
    default:
      return {
        title: "This app isn't responding",
        body: 'If it just started, give it a few more seconds, then reload this page.',
        button: 'Open Companion Hub',
        reload: false,
      };
  }
}

const SPINNER = '<div class="spinner" aria-hidden="true"></div>';
const STOPPED_ICON =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>';
const ALERT_ICON =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6"/><path d="M12 17h.01"/></svg>';

export function renderAppStartingPage(page: AppStartingPage): string {
  const copy = copyFor(page);
  const href = copy.button ? linkTarget(page.hubUrl) : null;
  const visual = page.state === 'starting' ? SPINNER : page.state === 'stopped' ? STOPPED_ICON : ALERT_ICON;

  // Palette matches @companionintelligence/tokens (phthalo-mist), as on the Hub's sign-in handoff
  // page (portal-sso.ts), dark first with a light variant.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
${copy.reload ? `<meta http-equiv="refresh" content="${APP_STARTING_RELOAD_SECONDS}">\n` : ''}<title>${escapeHtml(copy.title)}</title>
<link rel="icon" href="data:,">
<style>
:root {
  color-scheme: dark light;
  --bg: #041620;
  --card: #0c323c;
  --fg: #e8f2f4;
  --muted: #a3babf;
  --border: #073038;
  --accent: #c5e8dc;
  --accent-fg: #041620;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f3faf7;
    --card: #f0f9f5;
    --fg: #0a222e;
    --muted: #3a524b;
    --border: #dfece6;
    --accent: #0a6358;
    --accent-fg: #f0fdf4;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 Manrope, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.card {
  width: 100%;
  max-width: 420px;
  padding: 32px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
}
.spinner {
  width: 34px;
  height: 34px;
  margin: 0 auto 20px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 900ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.icon { display: block; width: 34px; height: 34px; margin: 0 auto 20px; color: var(--accent); }
h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.btn {
  display: block;
  margin-top: 20px;
  padding: 10px 16px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.brand { margin: 0; font-size: 12px; }
</style>
</head>
<body>
<main class="card">
${visual}
<h1>${escapeHtml(copy.title)}</h1>
<p>${escapeHtml(copy.body)}</p>
${href && copy.button ? `<a class="btn" href="${escapeHtml(href)}">${escapeHtml(copy.button)}</a>\n` : ''}</main>
<p class="brand">Companion Hub</p>
</body>
</html>
`;
}
