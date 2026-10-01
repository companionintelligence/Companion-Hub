/**
 * Keep credentials out of the Hub's own log files and console.
 *
 * The logger serialises whatever object it is handed with `JSON.stringify`, and callers hand it
 * request bodies, headers, HTTP client errors (an Axios error serialises its whole request config,
 * `Authorization` header included) and URLs. Nothing downstream looks at what is written, so this is
 * the only place a credential can be stopped before it reaches `app.log`, which is also what the
 * Hub's log download hands out.
 *
 * Deliberately narrower than the Sentry scrubber: that one also masks home directories and
 * identities and matches words like "token" anywhere in free text, which is right for an event
 * leaving the machine and wrong for a log an operator reads to find out what went wrong.
 */

export const REDACTED = '[REDACTED]';

/**
 * Object keys whose value is a credential.
 *
 * `token` is matched as a whole word or a suffix (`token`, `refresh_token`, `accessToken`) and not
 * as a substring, so the counters that sit in inference logs — `max_tokens`, `inputTokens`,
 * `tokenCount` — keep their numbers.
 */
const SENSITIVE_KEY =
  /authorization|cookie|passw(?:or)?d|secret|api[-_ ]?key|(?:device|move|private|signing)[-_ ]?key|totp|bearer|ticket|dsn|pepper|signature|session[-_ ]?id|(?:^|[-_.])token$|[a-z]token$/i;

/** Query parameters whose value is a credential. */
const SENSITIVE_QUERY_PARAM =
  /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|passwd|sig|signature|ticket|session_id|sid|code|auth)=)[^&\s#"']+/gi;

const STRING_PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  [/tskey-[A-Za-z0-9-]+/gi, REDACTED],
  // Postgres, AMQP and Redis URLs carry the password in the authority section: keep the scheme and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, (_match, scheme) => `${scheme}${REDACTED}@`],
  [SENSITIVE_QUERY_PARAM, (_match, prefix) => `${prefix}${REDACTED}`],
];

const MAX_DEPTH = 8;

export function redactString(value: string): string {
  let redacted = value;

  for (const [pattern, replacement] of STRING_PATTERNS) {
    redacted = redacted.replace(pattern, replacement as never);
  }

  return redacted;
}

/**
 * A copy of `value` that is safe to serialise: credential-named keys replaced, credential-shaped
 * strings masked, `toJSON()` honoured the way `JSON.stringify` would, and cycles and runaway depth cut.
 */
export function redactForLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= MAX_DEPTH) {
    return '[Truncated]';
  }

  seen.add(value);

  try {
    // `JSON.stringify` serialises through `toJSON`; an Axios error's is what carries its request config.
    const jsonable = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof jsonable === 'function') {
      const converted = jsonable.call(value);
      return converted === value ? redactObject(value, depth, seen) : redactForLog(converted, depth + 1, seen);
    }

    return redactObject(value, depth, seen);
  } finally {
    seen.delete(value);
  }
}

function redactObject(value: object, depth: number, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, depth + 1, seen));
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactForLog(entry, depth + 1, seen);
  }

  return redacted;
}
