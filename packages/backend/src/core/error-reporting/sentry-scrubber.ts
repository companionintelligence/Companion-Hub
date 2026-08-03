/**
 * `beforeSend` payload scrubber.
 *
 * The hub runs on the user's own machine and proxies their apps, so anything on
 * its way to Sentry is treated as hostile until proven otherwise: credentials
 * are redacted, home directories are collapsed to `~` (they leak account
 * names), request bodies and cookies are dropped, and oversized strings are
 * truncated so a stray blob can't smuggle app data out inside an exception.
 *
 * Kept in parity with CI-Server's `common/telemetry/scrubEvent.ts` and the
 * frontend's `lib/sentry-scrubber.ts` — the three live in separate build
 * graphs, so a rule added here has to be added there too.
 */

import type { ErrorEvent, EventHint } from '@sentry/node';
import { ApiKeyStoreUnavailableError, isTransientDbError } from '@/modules/api-keys/api-key.errors';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[-_ ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  // Postgres/Redis/AMQP URLs carry credentials in the authority section.
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

// `api[-_ ]?key` (not the literals `apikey|api_key`) so the hyphenated header
// forms match too — the SDK ships request headers even with sendDefaultPii
// disabled.
const SENSITIVE_KEY_PATTERN = /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|signature/i;

// Keys that name a PERSON rather than carrying a credential. No value pattern
// can ever match these — a username is just a word — so the key is the only
// signal, the same reason we drop `server_name`. This matters behind the hub's
// own Traefik forward-auth: the SDK captures headers that ARRIVED, so a
// proxy-injected `x-ci-hub-user` reaches the event with no reference in our
// code at all.
//
// Anchored on purpose: `user-agent`, `user_id` and `owner_id` are diagnostic
// signal worth keeping, and a naive /user|owner/ would eat all three.
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

/** Single predicate so credential and identity coverage cannot diverge. */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

// Headers whose value is a URL the user navigated from — same query-string
// exposure as request.url, and not caught by SENSITIVE_KEY_PATTERN.
const URL_VALUED_HEADERS = ['referer', 'referrer', 'location'];

// Breadcrumb `data` keys the SDK fills with URLs: `url` on http/fetch crumbs,
// `from`/`to` on navigation crumbs. A crumb for a token-bearing URL leaks it
// even when the event itself is clean.
const URL_VALUED_DATA_KEYS = ['url', 'from', 'to'];

const MAX_STRING_LENGTH = 8000;

/** Guard against cyclic/deep structures stalling the reporting path. */
const MAX_SCRUB_DEPTH = 8;

/**
 * Strip query and hash from a URL. On the hub those carry app names, search
 * terms and one-shot tokens (`/auth/reset-password?token=…`).
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

function scrubValue(value: unknown, depth = 0): unknown {
  // A runaway walk in beforeSend would stall reporting on every captured error.
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

function isTransientDbSentryNoise(event: ErrorEvent, hint: EventHint | undefined): boolean {
  const original = hint?.originalException;
  if (original instanceof ApiKeyStoreUnavailableError) {
    return true;
  }
  if (isTransientDbError(original)) {
    return true;
  }
  // Nest may wrap the driver error as ServiceUnavailableException with cause set.
  if (original instanceof Error && isTransientDbError(original.cause)) {
    return true;
  }

  const exceptionText = event.exception?.values?.map((value) => `${value.type ?? ''} ${value.value ?? ''}`).join(' ') ?? event.message ?? '';
  return /EAI_AGAIN|ENOTFOUND|ApiKeyStoreUnavailable|Database temporarily unavailable/i.test(exceptionText);
}

export function scrubEvent(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  // Docker DNS blips (`EAI_AGAIN ci-hub-db`) and exhausted auth-store retries are
  // infrastructure noise, not hub bugs. Keep one grouped warning so outages stay
  // visible without creating a new high-priority issue per failing query.
  if (isTransientDbSentryNoise(event, hint)) {
    event.level = 'warning';
    event.fingerprint = ['transient-db-unreachable'];
    event.tags = { ...event.tags, error_class: 'transient-db-unreachable' };
  }

  if (event.message) {
    event.message = scrubString(event.message);
  }

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        exception.value = scrubString(exception.value);
      }

      // Node's stack parser keeps the absolute path in `filename`/`abs_path`,
      // which leaks the account name outside Docker, and `vars` holds captured
      // locals — on the hub those are compose env, tokens and app config.
      for (const frame of exception.stacktrace?.frames ?? []) {
        if (typeof frame.filename === 'string') {
          frame.filename = scrubString(frame.filename);
        }

        if (typeof frame.abs_path === 'string') {
          frame.abs_path = scrubString(frame.abs_path);
        }

        // The ContextLines integration attaches the source around the throw
        // site. That is real source text — hardcoded keys, connection strings
        // and paths live there.
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
  // to `~` to avoid — on a laptop it is usually the owner's name.
  delete event.server_name;

  if (event.request) {
    // `include.cookies` defaults on and is NOT gated behind `sendDefaultPii`, so
    // the session cookie and any POSTed body reach here regardless of that flag.
    delete event.request.cookies;
    delete event.request.data;

    if (event.request.query_string) {
      event.request.query_string = '[Filtered]';
    }

    // `request.url` is built from `req.url`, which on a Node server is
    // path+query — so it carries byte-identical content to the query_string we
    // just filtered. Filtering one without the other redacts nothing.
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
