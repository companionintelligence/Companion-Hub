/**
 * Shared helpers for cooperative cancellation via `AbortSignal`.
 *
 * Lifecycle commands and the Docker service thread an `AbortSignal` through their long-running
 * steps (image pulls, `docker compose` spawns) and use these helpers to raise and recognise a
 * consistent abort error, so callers can distinguish a user-requested cancel from a real failure.
 */

/** Create the canonical abort error (a DOMException named `AbortError`). */
export function abortError(message = 'Aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

/** Type guard: true when an unknown error represents an abort (cancellation), not a failure. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Throw the canonical abort error if the signal is already aborted; otherwise do nothing. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}
