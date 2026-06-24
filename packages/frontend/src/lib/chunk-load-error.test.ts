import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, recoverFromChunkLoadError, retryDynamicImport } from './chunk-load-error';

describe('chunk-load-error', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects stale dynamic import failures', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://localhost/app.js'))).toBe(true);
    expect(isChunkLoadError(new Error('other'))).toBe(false);
  });

  it('reloads once when recovering from a chunk load error', () => {
    const error = new TypeError('Failed to fetch dynamically imported module: http://localhost/app.js');

    expect(recoverFromChunkLoadError(error)).toBe(true);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('ci-hub-chunk-reload')).toBe('1');

    expect(recoverFromChunkLoadError(error)).toBe(false);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('ci-hub-chunk-reload')).toBeNull();
  });

  it('retries dynamic imports through the chunk recovery path', async () => {
    const error = new TypeError('Failed to fetch dynamically imported module: http://localhost/app.js');
    const importFn = vi.fn().mockRejectedValue(error);

    const pending = retryDynamicImport(importFn);

    await expect(Promise.race([pending, Promise.resolve('reload-triggered')])).resolves.toBe('reload-triggered');
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });
});
