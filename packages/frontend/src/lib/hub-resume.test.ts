import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearIdleResumeReloadGuard, consumeIdleResumeReload, firstOf, HUB_IDLE_RESUME_MS, subscribeHubResume } from './hub-resume';

describe('firstOf', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the work value when it settles in time', async () => {
    const result = firstOf(Promise.resolve('ok'), 'fallback', 1_000);
    await expect(result).resolves.toBe('ok');
  });

  it('returns the fallback when work never settles', async () => {
    const result = firstOf(new Promise<string>(() => undefined), 'fallback', 1_000);
    const pending = result;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe('fallback');
  });
});

describe('subscribeHubResume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire on a short tab switch', () => {
    const onResume = vi.fn();
    const stop = subscribeHubResume(onResume, HUB_IDLE_RESUME_MS);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onResume).not.toHaveBeenCalled();
    stop();
  });

  it('fires after a long idle when the tab is visible again', () => {
    const onResume = vi.fn();
    const stop = subscribeHubResume(onResume, HUB_IDLE_RESUME_MS);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(HUB_IDLE_RESUME_MS);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onResume).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('consumeIdleResumeReload', () => {
  afterEach(() => {
    clearIdleResumeReloadGuard();
  });

  it('allows one automatic reload then refuses the next', () => {
    expect(consumeIdleResumeReload()).toBe(true);
    expect(consumeIdleResumeReload()).toBe(false);
  });
});
