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
  /authorization|cookie|passw(?:or)?d|passphrase|secret|credential|api[-_ ]?key|(?:device|move|private|signing|access|auth|encryption|master|hub[-_ ]?local|push)[-_ ]?key|totp|bearer|ticket|dsn|pepper|signature|session[-_ ]?id|jwt|(?:^|[-_.])(?:token|pin|pass|pwd|psw|pw)$|[a-z]token$/i;

/**
 * Credential names inside a quoted JSON fragment of free text, such as a message that embeds the
 * request body that failed. The bounds keep the pattern linear on adversarial input.
 */
const JSON_FRAGMENT_SECRET =
  /("[^"\\\n]{0,64}(?:(?:passw(?:or)?d|passphrase|secret|credential|api[-_ ]?key|private[-_ ]?key|device[-_ ]?key|access[-_ ]?key|authorization|cookie|totp)[^"\\\n]{0,64}|token)"\s{0,8}:\s{0,8})"(?:[^"\\]|\\.){0,2048}"/gi;

/** `NAME=value` as an environment listing prints it (a container's `Env` array, a `.env` dump). */
const ENV_ASSIGNMENT =
  /\b((?:[A-Z][A-Z0-9_]{0,64})?(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)(?:_[A-Z0-9_]{0,64})?=)[^\s"']{1,2048}/g;

/** Query parameters whose value is a credential. */
const SENSITIVE_QUERY_PARAM =
  /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|passwd|sig|signature|ticket|session_id|sid|code|auth)=)[^&\s#"']+/gi;

const STRING_PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  [/tskey-[A-Za-z0-9-]+/gi, REDACTED],
  // Postgres, AMQP and Redis URLs carry the password in the authority section: keep the scheme and host.
  // ⚠ Every quantifier is bounded. The log call runs on request bodies before anything authenticates
  // the caller, and an unbounded scheme (`[a-z0-9+.-]*`) made a body of `a-a-a-…` cost quadratic time:
  // 64 KB of it stalled the event loop for five seconds.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s:@/]{1,256}:[^\s@/]{1,256}@/gi, (_match, scheme) => `${scheme}${REDACTED}@`],
  [SENSITIVE_QUERY_PARAM, (_match, prefix) => `${prefix}${REDACTED}`],
  [JSON_FRAGMENT_SECRET, (_match, prefix) => `${prefix}"${REDACTED}"`],
  [ENV_ASSIGNMENT, (_match, prefix) => `${prefix}${REDACTED}`],
];

/**
 * How deep the copy goes. Deep enough for a compose tree with device reservations; the bound is only
 * there so a body nested thousands of levels deep cannot overflow the stack before the caller is
 * authenticated, and `seen` ends a circular object on its own.
 */
const MAX_DEPTH = 32;

/** Longest string parsed as JSON to look inside it. A larger one is only pattern-masked. */
const MAX_JSON_STRING_LENGTH = 256 * 1024;

export function redactString(value: string): string {
  const structured = redactSerialisedJson(value);
  let redacted = structured ?? value;

  for (const [pattern, replacement] of STRING_PATTERNS) {
    redacted = redacted.replace(pattern, replacement as never);
  }

  return redacted;
}

/**
 * A string that is itself a JSON document, redacted by key. An Axios error carries the request body
 * as such a string (`config.data`), which the patterns cannot tell apart from prose.
 *
 * @returns the redacted document, or `undefined` when `value` is not one
 */
function redactSerialisedJson(value: string): string | undefined {
  if (value.length > MAX_JSON_STRING_LENGTH) {
    return undefined;
  }

  const first = value.trimStart()[0];

  if (first !== '{' && first !== '[') {
    return undefined;
  }

  try {
    return JSON.stringify(redactForLog(JSON.parse(value)));
  } catch {
    return undefined;
  }
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

  // `fromEntries`, not assignment: a parsed body can have an own `__proto__` key, which assignment
  // would turn into a prototype change and drop from the output.
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) && isCredentialValue(entry) ? REDACTED : redactForLog(entry, depth + 1, seen),
    ]),
  );
}

/**
 * Whether what is held under a credential's name is worth hiding. A flag (`totpEnabled: false`), a
 * missing value and an empty string say whether a credential is set, which is what a reader of the
 * log needs to know; a string, a number (a PIN sent as a JSON number), an object or a list could be
 * the credential itself.
 */
function isCredentialValue(entry: unknown): boolean {
  if (entry === null || entry === undefined || typeof entry === 'boolean') {
    return false;
  }

  return entry !== '';
}
