/**
 * `beforeSend` payload scrubber.
 *
 * The Hub runs the user's whole appliance and proxies their apps, so anything
 * on its way to Sentry is treated as hostile until proven otherwise:
 * credentials are redacted, home directories are collapsed to `~` (they leak
 * the OS account name), request bodies and cookies are dropped, and oversized
 * strings are truncated so a stray blob cannot smuggle app data out inside an
 * exception message.
 *
 * Kept in lockstep with CI-Server's copy at
 * `backend/apps/api/src/common/telemetry/scrubEvent.ts`, which was originally
 * ported *from* this file and has since grown the rules below, and with the
 * frontend's browser twin at `packages/frontend/src/lib/sentry-scrubber.ts`.
 * Duplicated rather than shared because the three live in separate build
 * graphs, so a rule added here has to be added there too.
 *
 * What matters most here is the set of fields the SDK populates on its own,
 * behind our backs:
 *
 *   - `requestDataIntegration` is a @sentry/node-core default and stays enabled
 *     (instrument.ts only filters the two uncaught-exception handlers). It
 *     writes `event.request` — url, query_string, headers, cookies — and
 *     `event.user.ip_address`, all *before* `beforeSend` runs. `request.url` is
 *     built from `req.url`, which on Node is path+query, and the SDK includes it
 *     unconditionally regardless of `sendDefaultPii`.
 *   - `contextLinesIntegration` (also a default) attaches seven source lines
 *     around every in-app frame — real source text, where hardcoded keys and
 *     connection strings live.
 *   - `nativeNodeFetchIntegration` puts the raw query string of every outbound
 *     request on breadcrumbs as `data['http.query']`. `tracesSampleRate: 0` does
 *     not prevent this; the undici instrumentation runs regardless.
 *   - The server runtime stamps `event.server_name` from `os.hostname()`.
 *
 * None of that appears anywhere in our own code, which is exactly why it went
 * unscrubbed for so long.
 */

import type { ErrorEvent, EventHint } from '@sentry/node';
import { ApiKeyStoreUnavailableError, isTransientDbError } from '@/modules/api-keys/api-key.errors';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // `api[-_ ]?key`, not the literals `apikey|api_key`, so the hyphenated header
  // forms match too — `x-api-key` was previously missed entirely. The Portal
  // device and move keys go by field name only (`device_key`, `moveKey`): with a
  // space allowed, every sentence saying "device key" would lose its next word.
  /(?:api[-_ ]?key|device[-_]?key|move[-_]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
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
// forms match too — the SDK ships request headers even with `sendDefaultPii`
// disabled, so `x-api-key` arrives here whatever that flag is set to.
const SENSITIVE_KEY_PATTERN =
  /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|device[-_]?key|move[-_]?key|dsn|pepper|private[-_]?key|signature/i;

// Keys that name a PERSON rather than carrying a credential. No value pattern
// can ever match these — a username is just a word — so the key is the only
// signal, the same reason we drop `server_name`. This matters behind the Hub's
// own Traefik forward-auth: the SDK captures headers that ARRIVED, so a
// proxy-injected `x-ci-hub-user` reaches the event with no reference to it
// anywhere in our code.
//
// Anchored on purpose: `user-agent`, `user_id` and `owner_id` are diagnostic
// signal worth keeping, and a naive /user|owner/ would eat all three.
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

/** Single predicate so credential and identity coverage cannot diverge. */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

/**
 * Breadcrumb `data` keys the SDK fills with URLs: `url` on http/fetch crumbs,
 * `from`/`to` on navigation crumbs. A crumb for a token-bearing URL leaks it
 * even when the event itself is clean.
 */
const URL_VALUED_KEYS = new Set(['url', 'from', 'to']);

/**
 * Breadcrumb `data` keys that are a bare query string or fragment.
 *
 * `nativeNodeFetchIntegration` sanitises `data.url` (query and userinfo already
 * stripped) but then attaches the removed parts verbatim as `http.query` and
 * `http.fragment`. They match no secret pattern and no sensitive key, so they
 * have to go by name — `?token=…&api_key=…` rides out otherwise.
 */
const QUERY_VALUED_KEYS = new Set(['http.query', 'http.fragment']);

/**
 * Headers whose value is a URL the user navigated from — same query-string
 * exposure as `request.url`, and not caught by `SENSITIVE_KEY_PATTERN`.
 */
const URL_VALUED_HEADERS = ['referer', 'referrer', 'location'];

const MAX_STRING_LENGTH = 8000;

/** Guard against cyclic/deep structures stalling the reporting path. */
const MAX_SCRUB_DEPTH = 8;

/**
 * Strip query and hash from a URL. On this appliance those carry app slugs,
 * search terms and pairing codes.
 *
 * Deliberately a plain split rather than `new URL()`: it leaves the origin and
 * path exactly as written (no percent-encoding, no base-URL guessing for
 * relative paths) and cannot throw.
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
  // A runaway walk in beforeSend would stall the reporting path on every
  // captured error, and a cyclic payload would never terminate at all.
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
function scrubBreadcrumb(breadcrumb: { message?: string; data?: Record<string, unknown> }): void {
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = scrubString(breadcrumb.message);
  }

  if (!breadcrumb.data) {
    return;
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
  return /EAI_AGAIN|ENOTFOUND|ApiKeyStoreUnavailable|Database temporarily unavailable|Authentication temporarily unavailable|API key store unreachable/i.test(
    exceptionText,
  );
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
      // locals. `contextLinesIntegration` attaches the source around the throw
      // site — real source text, sitting unscrubbed right beside the filename we
      // were already careful about.
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
  // to `~` to avoid — personal machines are routinely named after their owner.
  // `includeServerName: false` in instrument.ts stops the SDK setting it; this is
  // the belt-and-braces half.
  delete event.server_name;

  // `sendDefaultPii: false` stops the SDK inferring `ip_address`, but a stray
  // `setUser({ email })` anywhere would bypass that. `user.id` — our device_id —
  // is the only identifier we intend to send.
  if (event.user) {
    const user = event.user as Record<string, unknown>;

    for (const key of Object.keys(user)) {
      if (key === 'ip_address' || isSensitiveKey(key)) {
        delete user[key];
      }
    }
  }

  if (event.request) {
    // Query strings and bodies routinely carry app slugs, pairing codes and
    // search terms; headers carry the session cookie. `include.cookies`
    // defaults on and is NOT gated behind `sendDefaultPii`, so the session
    // cookie and any POSTed body reach here regardless of that flag.
    delete event.request.cookies;
    delete event.request.data;

    if (event.request.query_string) {
      event.request.query_string = '[Filtered]';
    }

    // `request.url` is built from `req.url`, which on a Node server is
    // path+query — byte-identical content to the query_string we just filtered.
    // Filtering one without the other redacts nothing.
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

  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubBreadcrumb(breadcrumb);
  }

  return event;
}
