/**
 * Classification for API-key store failures (issue #933). When Postgres is unreachable —
 * `getaddrinfo EAI_AGAIN ci-hub-db` under Docker DNS pressure, a connection refused during
 * container startup ordering, a dropped socket — the key lookup cannot answer "valid or not".
 * Treating that as an invalid key returns 401 to a correctly-credentialed client and points
 * operators at the wrong layer. These helpers let the auth path tell the two apart.
 */

/** Node network errnos that mean "the database could not be reached", not "the query is wrong". */
const TRANSIENT_ERRNO_CODES = new Set([
  'EAI_AGAIN', // DNS lookup timed out (the exact failure in #933)
  'ENOTFOUND', // DNS name not resolvable right now
  'ECONNREFUSED', // DB not accepting connections (yet)
  'ECONNRESET', // connection dropped mid-flight
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Postgres SQLSTATE classes that signal connection-level trouble rather than a bad query:
 * class 08 (connection exception) and 57P03 (cannot_connect_now, e.g. DB still starting up).
 */
function isTransientSqlState(code: string): boolean {
  return code.startsWith('08') || code === '57P03';
}

/**
 * Some wrapped driver failures (including certain Drizzle/pg wrapping chains) lose the top-level
 * `code` but keep the errno token in `message` (`getaddrinfo EAI_AGAIN ci-hub-db`). Treat those as
 * transient too, or auth paths regress to "invalid key" behavior during brief infra churn.
 */
function hasTransientErrnoInMessage(message: string): boolean {
  return /\b(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/i.test(message);
}

/**
 * Whether an error (or anything in its `cause` chain — Drizzle wraps driver errors in
 * `DrizzleQueryError` with the original as `cause`) is a transient infrastructure failure.
 */
export function isTransientDbError(err: unknown): boolean {
  let current: unknown = err;
  // Bounded walk: cause chains are short, and a cycle must not hang the auth path.
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && (TRANSIENT_ERRNO_CODES.has(code) || isTransientSqlState(code))) {
      return true;
    }
    if (hasTransientErrnoInMessage(current.message)) {
      return true;
    }
    // node-postgres pool timeouts carry a message but no code.
    if (/timeout exceeded when trying to connect|Connection terminated/i.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Thrown by {@link ApiKeyService} when the key store cannot be consulted after retries.
 * Guards translate this into a 503 — "we could not check your key" — instead of the 401
 * "your key is wrong" that a store outage used to masquerade as.
 */
export class ApiKeyStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super('API key store unavailable: database unreachable');
    this.name = 'ApiKeyStoreUnavailableError';
    this.cause = cause;
  }
}
