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
 * Matches by `name` so it recognises both `DOMException` aborts and Node's own `AbortError`
 * (e.g. the error `spawn({ signal })` emits), regardless of the concrete error class.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Throw the canonical abort error if the signal is already aborted; otherwise do nothing. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}
