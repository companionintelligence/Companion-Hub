/**
 * Shared helpers for cooperative cancellation via `AbortSignal`.
 *
 * Lifecycle commands and the Docker service thread an `AbortSignal` through their long-running
 * steps (image pulls, `docker compose` spawns) and use these helpers to raise and recognise a
 * consistent abort error, so callers can distinguish a user-requested cancel from a real failure.
 */

/** Create the canonical abort error: a `DOMException` named `AbortError` where available, otherwise a
 * plain `Error` with the same `name` (older/edge Node runtimes may not expose `DOMException`). */
export function abortError(message = 'Aborted'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Type guard: true when an unknown error represents an abort (cancellation), not a failure.
 * Matches on `name`/`code` rather than the concrete class, so it recognises a `DOMException` named
 * `AbortError`, our plain-Error fallback, and Node's own `AbortError` (`code: 'ABORT_ERR'`, e.g. the
 * error `spawn({ signal })` emits) — `DOMException` is not guaranteed to extend `Error` everywhere.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

/** Throw the canonical abort error if the signal is already aborted; otherwise do nothing. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}
