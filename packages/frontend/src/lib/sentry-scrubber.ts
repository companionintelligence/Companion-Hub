/**
 * Browser payload scrubber.
 *
 * The frontend bundle previously shipped with no scrubber at all — its
 * `beforeSend` only gated consent, dropped known noise, and enriched
 * `TranslatableError`, returning the event otherwise untouched. That left the
 * browser SDK's own defaults to ship raw:
 *
 *   - `httpContextIntegration` (a @sentry/browser default) sets
 *     `event.request.url` to the full `window.location.href` — query and hash
 *     included — and `headers.Referer` to `document.referrer`. It does this
 *     unconditionally, with no `sendDefaultPii` check.
 *   - `breadcrumbsIntegration` records fetch/xhr crumbs carrying `data.url`
 *     with the full query string, and console crumbs carrying the joined
 *     `message` plus raw `data.arguments`.
 *
 * Kept in lockstep with the backend copy at
 * `packages/backend/src/core/error-reporting/sentry-scrubber.ts` and with
 * CI-Server's browser twin at `frontend/apps/web/src/lib/telemetry.ts`.
 * Duplicated rather than shared because they live in separate build graphs;
 * change them together.
 */

import type { Breadcrumb, ErrorEvent } from '@sentry/react';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[-_ ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

// Windows first — see the note on the backend copy: the macOS pattern otherwise
// matches inside `C:/Users/<name>` and leaves a stranded `C:~/…`.
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
];

// Desktop builds run the same bundle inside the Tauri shell, where an error
// message can carry the Hub's own data directory verbatim.
const APPLICATION_SUPPORT_PATTERN = /Library\/Application Support\/[^\s]+/g;

// `api[-_ ]?key`, not the literals `apikey|api_key`, so the hyphenated header
// forms match too.
const SENSITIVE_KEY_PATTERN = /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|signature/i;

// Keys that name a PERSON rather than carrying a credential. Anchored on
// purpose: `user-agent`, `user_id` and `owner_id` are diagnostic signal worth
// keeping, and a naive /user|owner/ would eat all three.
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

/**
 * Breadcrumb `data` keys the SDK fills with URLs: `url` on fetch/xhr crumbs,
 * `from`/`to` on navigation crumbs. A route change to a token-bearing URL
 * leaves the token in the crumb even when the event itself is clean.
 */
const URL_VALUED_KEYS = new Set(['url', 'from', 'to']);

/** Breadcrumb `data` keys that are a bare query string or fragment. */
const QUERY_VALUED_KEYS = new Set(['http.query', 'http.fragment']);

/**
 * Request headers whose value is a URL the user navigated from — same
 * query-string exposure as `request.url`, and not caught by
 * `SENSITIVE_KEY_PATTERN`.
 */
const URL_VALUED_HEADERS = ['referer', 'referrer', 'location'];

const MAX_STRING_LENGTH = 8000;

/** Guard against cyclic/deep structures stalling the reporting path. */
const MAX_SCRUB_DEPTH = 8;

/**
 * Strip query and hash. Deliberately a plain split rather than `new URL()`: it
 * leaves origin and path exactly as written and cannot throw.
 */
export function scrubUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

export function scrubString(value: string): string {
  let scrubbed = value;

  for (const pattern of HOME_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '~');
  }

  scrubbed = scrubbed.replace(APPLICATION_SUPPORT_PATTERN, '…/Application Support/…');

  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[Filtered]');
  }

  if (scrubbed.length > MAX_STRING_LENGTH) {
    return `${scrubbed.slice(0, MAX_STRING_LENGTH)}… [truncated]`;
  }

  return scrubbed;
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) {
    return '[Truncated]';
  }

  if (typeof value === 'string') {
    return scrubString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? '[Filtered]' : scrubValue(nested, depth + 1);
    }

    return result;
  }

  return value;
}

/**
 * Scrub one breadcrumb in place.
 *
 * `data` is passed to the walker as a WHOLE OBJECT, never per value: the
 * sensitive-key check only runs while walking an object's own entries, so
 * scrubbing each value individually would let a bare `data.token` through — the
 * value on its own matches no secret pattern.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = scrubString(breadcrumb.message);
  }

  if (!breadcrumb.data) {
    return breadcrumb;
  }

  const data = scrubValue(breadcrumb.data) as Record<string, unknown>;

  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      continue;
    }

    if (QUERY_VALUED_KEYS.has(key)) {
      data[key] = '[Filtered]';
    } else if (URL_VALUED_KEYS.has(key)) {
      data[key] = scrubUrl(value);
    }
  }

  breadcrumb.data = data;

  return breadcrumb;
}

/** Scrub everything the browser SDK attaches. Mutates and returns the event. */
export function scrubBrowserEvent(event: ErrorEvent): ErrorEvent {
  if (event.message) {
    event.message = scrubString(event.message);
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = scrubString(exception.value);
    }

    for (const frame of exception.stacktrace?.frames ?? []) {
      if (typeof frame.filename === 'string') {
        frame.filename = scrubString(frame.filename);
      }

      if (typeof frame.abs_path === 'string') {
        frame.abs_path = scrubString(frame.abs_path);
      }

      // Source context around the throw site is real source text — hardcoded
      // keys and connection strings live there. The browser SDK does not attach
      // it by default, but a source-map/`ContextLines`-style producer can, so
      // the rule is kept in parity with the backend twin.
      if (typeof frame.context_line === 'string') {
        frame.context_line = scrubString(frame.context_line);
      }

      for (const key of ['pre_context', 'post_context'] as const) {
        const lines = frame[key];

        if (Array.isArray(lines)) {
          frame[key] = lines.map((line) => (typeof line === 'string' ? scrubString(line) : line));
        }
      }

      if (frame.vars) {
        frame.vars = scrubValue(frame.vars) as Record<string, unknown>;
      }
    }
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra) as Record<string, unknown>;
  }

  // Hostname-equivalent for the browser; nothing sets it today, but the field
  // exists and costs nothing to clear.
  delete event.server_name;

  if (event.user) {
    const user = event.user as Record<string, unknown>;

    for (const key of Object.keys(user)) {
      if (key === 'ip_address' || isSensitiveKey(key)) {
        delete user[key];
      }
    }
  }

  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;

    // Replaced rather than deleted, matching the backend twin: the field's
    // presence is diagnostic (a query existed), its contents are not.
    if (event.request.query_string) {
      event.request.query_string = '[Filtered]';
    }

    // `httpContextIntegration` sets this to the full `window.location.href`.
    if (typeof event.request.url === 'string') {
      event.request.url = scrubUrl(event.request.url);
    }

    // The browser's default referrer policy keeps the full same-origin URL —
    // query string and all — which is exactly what scrubUrl exists to remove.
    if (event.request.headers) {
      const headers = scrubValue(event.request.headers) as Record<string, string>;

      for (const [key, value] of Object.entries(headers)) {
        if (URL_VALUED_HEADERS.includes(key.toLowerCase()) && typeof value === 'string') {
          headers[key] = scrubUrl(value);
        }
      }

      event.request.headers = headers;
    }
  }

  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubBreadcrumb(breadcrumb);
  }

  return event;
}
