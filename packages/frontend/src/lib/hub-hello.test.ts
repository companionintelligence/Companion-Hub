import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isStackUpdatePending, markStackUpdatePending, subscribeStackUpdate } from './desktop-stack-session';
import { STACK_UPDATE_NOT_CONFIRMED_AFTER_MS, applyHubHello, decideHubHello } from './hub-hello';

const NOW = 1_700_000_000_000;

describe('decideHubHello', () => {
  it('ignores an empty hello', () => {
    expect(decideHubHello({ helloVersion: '', bundleVersion: '0.2.71', pending: null, sameOriginBundle: true, now: NOW })).toEqual({ kind: 'none' });
  });

  it('is quiet when nothing is pending and the bundle matches the Hub', () => {
    expect(
      decideHubHello({
        helloVersion: 'v0.2.72',
        helloBuildVersion: 'v0.2.72',
        bundleVersion: '0.2.72',
        pending: null,
        sameOriginBundle: true,
        now: NOW,
      }),
    ).toEqual({
      kind: 'none',
    });
  });

  it('completes a pending update when the Hub answers on a different version', () => {
    const pending = { fromVersion: '0.2.71', startedAt: NOW - 30_000 };
    expect(decideHubHello({ helloVersion: '0.2.72', bundleVersion: '0.2.71', pending, sameOriginBundle: true, now: NOW })).toEqual({
      kind: 'update_completed',
      version: '0.2.72',
    });
  });

  it('keeps waiting when the old container answers shortly after the request', () => {
    const pending = { fromVersion: '0.2.71', startedAt: NOW - 30_000 };
    expect(decideHubHello({ helloVersion: '0.2.71', bundleVersion: '0.2.71', pending, sameOriginBundle: true, now: NOW })).toEqual({ kind: 'none' });
  });

  it('gives up on a pending update when the old version is still answering long after the request', () => {
    const pending = { fromVersion: '0.2.71', startedAt: NOW - STACK_UPDATE_NOT_CONFIRMED_AFTER_MS - 1 };
    expect(decideHubHello({ helloVersion: '0.2.71', bundleVersion: '0.2.71', pending, sameOriginBundle: true, now: NOW })).toEqual({
      kind: 'update_not_confirmed',
      version: '0.2.71',
    });
  });

  it('uses the bundle as the baseline for a legacy marker on a same-origin tab', () => {
    const legacy = { fromVersion: null, startedAt: null };
    expect(decideHubHello({ helloVersion: '0.2.71', bundleVersion: '0.2.71', pending: legacy, sameOriginBundle: true, now: NOW })).toEqual({
      kind: 'none',
    });
    expect(decideHubHello({ helloVersion: '0.2.72', bundleVersion: '0.2.71', pending: legacy, sameOriginBundle: true, now: NOW })).toEqual({
      kind: 'update_completed',
      version: '0.2.72',
    });
  });

  it('completes a legacy marker on the first hello when there is no baseline at all', () => {
    const legacy = { fromVersion: null, startedAt: null };
    expect(decideHubHello({ helloVersion: '0.2.71', bundleVersion: '9.9.9', pending: legacy, sameOriginBundle: false, now: NOW })).toEqual({
      kind: 'update_completed',
      version: '0.2.71',
    });
  });

  it('flags a stale same-origin bundle, and never a cross-origin one', () => {
    expect(
      decideHubHello({
        helloVersion: '0.2.72',
        helloBuildVersion: '0.2.72',
        bundleVersion: '0.2.71',
        pending: null,
        sameOriginBundle: true,
        now: NOW,
      }),
    ).toEqual({
      kind: 'bundle_stale',
      version: '0.2.72',
    });
    expect(
      decideHubHello({
        helloVersion: '0.2.72',
        helloBuildVersion: '0.2.72',
        bundleVersion: '0.2.71',
        pending: null,
        sameOriginBundle: false,
        now: NOW,
      }),
    ).toEqual({
      kind: 'none',
    });
  });

  // Image builds give the bundle version and the build stamp the same value; `version` comes from the
  // install's env file. Comparing the bundle with `version` would reload every new tab on a channel
  // image and on any install whose env file names another release.
  it('leaves a channel image alone, whose bundle and stamp both name the channel', () => {
    expect(
      decideHubHello({ helloVersion: '0.2.77', helloBuildVersion: 'dev', bundleVersion: 'dev', pending: null, sameOriginBundle: true, now: NOW }),
    ).toEqual({
      kind: 'none',
    });
  });

  it('leaves a tab alone when only the env file names another version', () => {
    expect(
      decideHubHello({
        helloVersion: '0.2.75',
        helloBuildVersion: '0.2.77',
        bundleVersion: '0.2.77',
        pending: null,
        sameOriginBundle: true,
        now: NOW,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('flags a bundle built by another image, whatever the env file says', () => {
    expect(
      decideHubHello({
        helloVersion: '0.2.78',
        helloBuildVersion: '0.2.78',
        bundleVersion: '0.2.77',
        pending: null,
        sameOriginBundle: true,
        now: NOW,
      }),
    ).toEqual({ kind: 'bundle_stale', version: '0.2.78' });
    expect(
      decideHubHello({
        helloVersion: '0.2.75',
        helloBuildVersion: '0.2.78',
        bundleVersion: '0.2.77',
        pending: null,
        sameOriginBundle: true,
        now: NOW,
      }),
    ).toEqual({ kind: 'bundle_stale', version: '0.2.78' });
  });

  it('never flags a stale bundle when the Hub sends no build stamp', () => {
    expect(decideHubHello({ helloVersion: '0.2.78', bundleVersion: '0.2.77', pending: null, sameOriginBundle: true, now: NOW })).toEqual({
      kind: 'none',
    });
    expect(
      decideHubHello({ helloVersion: '0.2.78', helloBuildVersion: null, bundleVersion: '0.2.77', pending: null, sameOriginBundle: true, now: NOW }),
    ).toEqual({ kind: 'none' });
  });
});

describe('applyHubHello', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('clears the marker, notifies subscribers, refetches the version and reloads a same-origin tab once', () => {
    markStackUpdatePending('0.2.71', NOW - 30_000);
    const outcomes: unknown[] = [];
    const unsubscribe = subscribeStackUpdate((outcome) => outcomes.push(outcome));
    const effects = { invalidateVersion: vi.fn(), reload: vi.fn() };

    applyHubHello('0.2.72', { bundleVersion: '0.2.71', sameOriginBundle: true, now: NOW }, effects);

    expect(isStackUpdatePending()).toBe(false);
    expect(outcomes).toEqual([{ state: 'completed', version: '0.2.72' }]);
    expect(effects.invalidateVersion).toHaveBeenCalledTimes(1);
    expect(effects.reload).toHaveBeenCalledTimes(1);

    // A second hello for the same version (e.g. the reload's own stream) must not loop.
    applyHubHello('0.2.72', { bundleVersion: '0.2.71', sameOriginBundle: true, now: NOW }, effects);
    expect(effects.reload).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does not reload a cross-origin desktop bundle when its update completes', () => {
    markStackUpdatePending('0.2.71', NOW - 30_000);
    const effects = { invalidateVersion: vi.fn(), reload: vi.fn() };
    applyHubHello('0.2.72', { bundleVersion: '1.0.0', sameOriginBundle: false, now: NOW }, effects);
    expect(isStackUpdatePending()).toBe(false);
    expect(effects.invalidateVersion).toHaveBeenCalledTimes(1);
    expect(effects.reload).not.toHaveBeenCalled();
  });

  it('leaves a fresh pending marker alone when the old container answers', () => {
    markStackUpdatePending('0.2.71', NOW - 30_000);
    const effects = { invalidateVersion: vi.fn(), reload: vi.fn() };
    expect(applyHubHello('0.2.71', { bundleVersion: '0.2.71', sameOriginBundle: true, now: NOW }, effects)).toEqual({ kind: 'none' });
    expect(isStackUpdatePending()).toBe(true);
    expect(effects.invalidateVersion).not.toHaveBeenCalled();
  });

  it('reports a not-confirmed update without reloading', () => {
    markStackUpdatePending('0.2.71', NOW - STACK_UPDATE_NOT_CONFIRMED_AFTER_MS - 1);
    const outcomes: unknown[] = [];
    const unsubscribe = subscribeStackUpdate((outcome) => outcomes.push(outcome));
    const effects = { invalidateVersion: vi.fn(), reload: vi.fn() };
    applyHubHello('0.2.71', { bundleVersion: '0.2.71', sameOriginBundle: true, now: NOW }, effects);
    expect(outcomes).toEqual([{ state: 'not_confirmed', version: '0.2.71' }]);
    expect(isStackUpdatePending()).toBe(false);
    expect(effects.reload).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('reloads a stale tab once per image version, even when the env file never changes', () => {
    const effects = { invalidateVersion: vi.fn(), reload: vi.fn() };

    applyHubHello('0.2.75', { bundleVersion: '0.2.77', helloBuildVersion: '0.2.78', sameOriginBundle: true, now: NOW }, effects);
    expect(effects.reload).toHaveBeenCalledTimes(1);

    // The reloaded page's own stream greets with the same image: no loop.
    applyHubHello('0.2.75', { bundleVersion: '0.2.77', helloBuildVersion: '0.2.78', sameOriginBundle: true, now: NOW }, effects);
    expect(effects.reload).toHaveBeenCalledTimes(1);

    // A later update in the same tab session is a new image, so the tab reloads again.
    applyHubHello('0.2.75', { bundleVersion: '0.2.78', helloBuildVersion: '0.2.79', sameOriginBundle: true, now: NOW }, effects);
    expect(effects.reload).toHaveBeenCalledTimes(2);
    expect(effects.invalidateVersion).not.toHaveBeenCalled();
  });
});
