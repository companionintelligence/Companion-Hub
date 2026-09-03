const CHUNK_RELOAD_KEY = 'ci-hub-chunk-reload';

export function isChunkLoadError(error: unknown): boolean {
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    return message.includes('failed to fetch dynamically imported module') || message.includes('importing a module script failed');
  }

  if (typeof error === 'string') {
    const message = error.toLowerCase();
    return message.includes('failed to fetch dynamically imported module') || message.includes('importing a module script failed');
  }

  return false;
}

/** Reload once on stale chunk hashes (deploy/HMR); avoids surfacing a broken lazy route. */
export function recoverFromChunkLoadError(error: unknown): boolean {
  if (!isChunkLoadError(error) || typeof window === 'undefined') {
    return false;
  }

  if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
    window.location.reload();
    return true;
  }

  sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  return false;
}

export function retryDynamicImport<T>(importFn: () => Promise<T>): Promise<T> {
  return importFn().catch((error: unknown) => {
    if (recoverFromChunkLoadError(error)) {
      return new Promise<T>(() => {
        // Page reload in progress; never resolve so React does not render a broken route.
      });
    }
    throw error;
  });
}
