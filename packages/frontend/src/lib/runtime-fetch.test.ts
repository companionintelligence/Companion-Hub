import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetActiveFetch, runtimeFetch, setActiveFetch } from './runtime-fetch';

describe('runtime-fetch', () => {
  afterEach(() => {
    resetActiveFetch();
    vi.restoreAllMocks();
  });

  it('delegates to window.fetch by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await runtimeFetch('https://example.com/x', { method: 'GET' });
    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/x', { method: 'GET' });
  });

  it('routes through the active fetch once swapped (mobile native HTTP)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('window'));
    const native = vi.fn(async () => new Response('native'));
    setActiveFetch(native);

    const res = await runtimeFetch('https://hub.ci.computer/api/health');
    expect(await res.text()).toBe('native');
    expect(native).toHaveBeenCalledWith('https://hub.ci.computer/api/health', undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reset restores window.fetch', async () => {
    const native = vi.fn(async () => new Response('native'));
    setActiveFetch(native);
    resetActiveFetch();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await runtimeFetch('https://example.com/y');
    expect(fetchSpy).toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
});
