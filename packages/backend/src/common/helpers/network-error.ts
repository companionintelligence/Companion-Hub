import { isIPv6 } from 'node:net';
import { scrubString } from '@/core/error-reporting/sentry-scrubber';

/**
 * How many wrappers to look through for the error Node raised for the socket. axios keeps it on
 * `cause`, so does undici's `fetch failed`, and a caller may wrap either of those again.
 */
const MAX_DEPTH = 5;

/** Addresses listed for one failed connection. A name rarely has more; the rest are counted. */
const MAX_ATTEMPTS = 8;

/** A description is one log line or one status field, never a paragraph. */
const MAX_LENGTH = 300;

/**
 * The only fields read from an error: what Node, axios and undici put on a failed request. An axios
 * error also carries the request's config, with its URL, headers and body, and none of that is read.
 */
type NetworkErrorFields = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  syscall?: unknown;
  address?: unknown;
  port?: unknown;
  hostname?: unknown;
  errors?: unknown;
  cause?: unknown;
};

/**
 * Why a request got no answer, in one line for a log or a status field.
 *
 * - A connection that failed on every address the name resolved to:
 *   `ETIMEDOUT 192.0.2.10:443, ENETUNREACH [2001:db8::10]:443`
 * - Any other failure Node reports for a socket: `getaddrinfo ENOTFOUND portal.example.com`,
 *   `connect ECONNREFUSED 192.0.2.10:443`
 * - Anything else, by its message and code: `timeout of 5000ms exceeded (ECONNABORTED)`
 *
 * The first case is why this exists. Node tries each of a name's addresses in turn and, when none
 * accepts the connection, throws an `AggregateError` whose message is empty and whose `errors` hold
 * the reason for each address. axios copies that empty message onto its own error, so a log line
 * built from `error.message` ended at its colon and said nothing about why.
 *
 * The result is scrubbed like an error report, so a credential in an error's message is not
 * repeated in the log.
 */
export function describeNetworkError(error: unknown): string {
  const description = (describeFailedSocket(error, 0) ?? describeMessage(error)).replace(/\s+/g, ' ').trim();
  const scrubbed = scrubString(description || 'unknown error');

  return scrubbed.length > MAX_LENGTH ? `${scrubbed.slice(0, MAX_LENGTH - 1)}…` : scrubbed;
}

/** The failed connection under `error`, or `null` when no wrapper holds one. */
function describeFailedSocket(error: unknown, depth: number): string | null {
  if (!isObject(error) || depth > MAX_DEPTH) {
    return null;
  }

  if (Array.isArray(error.errors) && error.errors.length > 0) {
    const attempts = error.errors.slice(0, MAX_ATTEMPTS).map((attempt) => describeAttempt(attempt, depth + 1));
    const untold = error.errors.length - attempts.length;

    return untold > 0 ? `${attempts.join(', ')}, and ${untold} more` : attempts.join(', ');
  }

  // Node names the call that failed (`connect`, `getaddrinfo`, `read`) on every socket error.
  if (typeof error.code === 'string' && typeof error.syscall === 'string') {
    return [error.syscall, error.code, target(error)].filter(Boolean).join(' ');
  }

  return describeFailedSocket(error.cause, depth + 1);
}

/** One address of a connection Node tried on several: `ETIMEDOUT 192.0.2.10:443`. */
function describeAttempt(attempt: unknown, depth: number): string {
  const fields: NetworkErrorFields = isObject(attempt) ? attempt : {};
  const where = target(fields);

  if (typeof fields.code === 'string' && where) {
    return `${fields.code} ${where}`;
  }

  return describeFailedSocket(attempt, depth) ?? describeMessage(attempt);
}

/** `192.0.2.10:443`, `[2001:db8::10]:443`, or the host name a lookup failed for. */
function target(fields: NetworkErrorFields): string {
  if (typeof fields.address === 'string' && fields.address) {
    const host = isIPv6(fields.address) ? `[${fields.address}]` : fields.address;

    return typeof fields.port === 'number' || typeof fields.port === 'string' ? `${host}:${fields.port}` : host;
  }

  return typeof fields.hostname === 'string' ? fields.hostname : '';
}

/**
 * An error that is not a failed socket: its message and its code. A wrapper with an empty message
 * or no code of its own takes them from what it wraps, as `fetch failed` takes undici's code.
 */
function describeMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }
  if (!isObject(error)) {
    return 'unknown error';
  }

  let message = '';
  let code = '';
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_DEPTH && isObject(current); depth++) {
    message ||= typeof current.message === 'string' ? current.message.trim() : '';
    code ||= typeof current.code === 'string' ? current.code : '';
    current = current.cause;
  }

  if (message && code && !message.includes(code)) {
    return `${message} (${code})`;
  }

  return message || code || (typeof error.name === 'string' && error.name) || 'unknown error';
}

function isObject(value: unknown): value is NetworkErrorFields {
  return typeof value === 'object' && value !== null;
}
