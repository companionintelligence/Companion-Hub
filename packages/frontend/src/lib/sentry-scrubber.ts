/**
 * Browser-side `beforeSend` payload scrubber.
 *
 * Kept in parity with `packages/backend/src/core/error-reporting/sentry-scrubber.ts`
 * — the two live in separate build graphs (Vite bundle vs Nest server), so a
 * rule added there has to be added here too. Only the transient-DB regroup is
 * backend-only.
 *
 * The browser SDK's `httpContextIntegration` sets `event.request.url` from
 * `location.href`, so an error thrown on `/auth/reset-password?token=…` ships
 * the live reset token unless the query string is stripped here.
 */

import type { ErrorEvent } from '@sentry/react';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[-_ ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  // Connection URLs carry credentials in the authority section.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

// Windows first: the macOS pattern also matches the `/Users/<name>` inside
// `C:/Users/<name>`, and replacing that leaves a stranded `C:~/…` with the drive
// letter still attached. The longest-prefix forms have to win.
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
];
const APPLICATION_SUPPORT_PATTERN = /Library\/Application Support\/[^\s]+/g;

const SENSITIVE_KEY_PATTERN = /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|signature/i;

// Keys that name a PERSON rather than carrying a credential. Anchored on
// purpose: `user-agent`, `user_id` and `owner_id` are diagnostic signal worth
// keeping, and a naive /user|owner/ would eat all three.
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

/** Single predicate so credential and identity coverage cannot diverge. */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

// Headers whose value is a URL the user navigated from — same query-string
// exposure as request.url, and not caught by SENSITIVE_KEY_PATTERN.
const URL_VALUED_HEADERS = ['referer', 'referrer', 'location'];

// Breadcrumb `data` keys the SDK fills with URLs: `url` on fetch/xhr crumbs,
// `from`/`to` on navigation crumbs. A route change to a token-bearing URL
// leaves the token in the crumb even when the event itself is clean.
const URL_VALUED_DATA_KEYS = ['url', 'from', 'to'];

const MAX_STRING_LENGTH = 8000;

/** Guard against cyclic/deep structures stalling the reporting path. */
const MAX_SCRUB_DEPTH = 8;

/** Strip query and hash from a URL — on the hub those carry search terms, app names and one-shot tokens. */
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

function scrubValue(value: unknown, depth = 0): unknown {
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

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.message) {
    event.message = scrubString(event.message);
  }

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
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
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra) as Record<string, unknown>;
  }

  // The hostname is the same account-identifying data we collapse `/Users/<name>`
  // to `~` to avoid.
  delete event.server_name;

  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;

    if (event.request.query_string) {
      event.request.query_string = '[Filtered]';
    }

    if (typeof event.request.url === 'string') {
      event.request.url = scrubUrl(event.request.url);
    }

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

  if (event.breadcrumbs) {
    for (const breadcrumb of event.breadcrumbs) {
      if (typeof breadcrumb.message === 'string') {
        breadcrumb.message = scrubString(breadcrumb.message);
      }

      if (breadcrumb.data) {
        const data = scrubValue(breadcrumb.data) as Record<string, unknown>;

        for (const key of URL_VALUED_DATA_KEYS) {
          const value = data[key];
          if (typeof value === 'string') {
            data[key] = scrubUrl(value);
          }
        }

        breadcrumb.data = data;
      }
    }
  }

  return event;
}
