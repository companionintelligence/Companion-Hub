/** Read a header from Axios's record-shaped headers or Fetch's Headers. */
export function readResponseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  const lower = name.toLowerCase();

  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (header: string) => unknown }).get(name) ?? (headers as { get: (header: string) => unknown }).get(lower);
    if (value == null) {
      return undefined;
    }
    return Array.isArray(value) ? String(value[0]) : String(value);
  }

  const record = headers as Record<string, unknown>;
  const raw = record[name] ?? record[lower];
  if (raw == null) {
    return undefined;
  }
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

/**
 * Parse `Retry-After` as a wait in seconds.
 *
 * Accepts a delta-seconds integer (what Portal sends) or an HTTP-date.
 */
export function parseRetryAfterSeconds(headers: unknown): number | undefined {
  const raw = readResponseHeader(headers, 'retry-after');
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const date = Date.parse(raw);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export function rateLimitedWaitCopy(headers: unknown): string {
  const retryAfter = parseRetryAfterSeconds(headers);
  if (retryAfter != null && retryAfter > 0) {
    return `Too many attempts. Try again in ${retryAfter} seconds.`;
  }
  return 'Too many attempts. Please wait a moment and try again.';
}
