import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildInstallIntentPath,
  clearStashedInstallIntentForApp,
  DEFAULT_INSTALL_STORE_ID,
  forgetInstallIntentForApp,
  peekStashedInstallIntent,
  shouldAutoOpenInstall,
  stashPendingInstallIntent,
  takeStashedInstallIntent,
} from './deep-link-install';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => core.invoke(...a) }));

const win = window as unknown as Record<string, unknown>;

describe('deep-link-install', () => {
  beforeEach(() => {
    sessionStorage.clear();
    core.invoke.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    delete win.__TAURI_INTERNALS__;
  });

  it('stashes and consumes install intents once', () => {
    stashPendingInstallIntent({ appSlug: 'immich', storeId: 'ci-marketplace' });
    expect(peekStashedInstallIntent()).toEqual({
      appSlug: 'immich',
      storeId: 'ci-marketplace',
      deviceId: null,
    });
    expect(takeStashedInstallIntent()).toEqual({
      appSlug: 'immich',
      storeId: 'ci-marketplace',
      deviceId: null,
    });
    expect(takeStashedInstallIntent()).toBeNull();
  });

  it('defaults missing store IDs to ci-marketplace', () => {
    stashPendingInstallIntent({ appSlug: 'plane', storeId: '' });
    expect(peekStashedInstallIntent()?.storeId).toBe(DEFAULT_INSTALL_STORE_ID);
  });

  it('builds install intent navigation paths', () => {
    expect(
      buildInstallIntentPath({
        appSlug: 'immich',
        storeId: 'ci-marketplace',
      }),
    ).toBe('/store/ci-marketplace/immich?install=1');
  });

  it('auto-opens when install=1 is present or stash matches', () => {
    expect(shouldAutoOpenInstall('immich', 'ci-marketplace', '?install=1')).toBe(true);

    stashPendingInstallIntent({ appSlug: 'immich', storeId: 'ci-marketplace' });
    expect(shouldAutoOpenInstall('immich', 'ci-marketplace', '')).toBe(true);
    expect(shouldAutoOpenInstall('plane', 'ci-marketplace', '')).toBe(false);
  });

  it('clears stash only for matching app and store', () => {
    stashPendingInstallIntent({ appSlug: 'immich', storeId: 'ci-marketplace' });
    clearStashedInstallIntentForApp('plane', 'ci-marketplace');
    expect(peekStashedInstallIntent()?.appSlug).toBe('immich');

    clearStashedInstallIntentForApp('immich', 'ci-marketplace');
    expect(peekStashedInstallIntent()).toBeNull();
  });

  it('escapes slugs so a hostile deep link cannot steer navigation', () => {
    // appSlug/storeId arrive from outside the app — anyone can hand the OS a
    // cihub://install link. Encoding is what keeps them a single path segment
    // instead of letting them climb the route tree or graft on query params.
    expect(buildInstallIntentPath({ appSlug: '../../admin', storeId: 'ci-marketplace' })).toBe('/store/ci-marketplace/..%2F..%2Fadmin?install=1');
    expect(buildInstallIntentPath({ appSlug: 'immich?admin=1', storeId: 'ci-marketplace' })).toBe(
      '/store/ci-marketplace/immich%3Fadmin%3D1?install=1',
    );
    expect(buildInstallIntentPath({ appSlug: 'a#b', storeId: 'x/y' })).toBe('/store/x%2Fy/a%23b?install=1');
  });

  it('treats a corrupt or half-written stash as empty', () => {
    sessionStorage.setItem('ci-hub.pending-install-intent', '{not json');
    expect(peekStashedInstallIntent()).toBeNull();

    // Valid JSON, but nothing we can act on.
    sessionStorage.setItem('ci-hub.pending-install-intent', JSON.stringify({ storeId: 'ci-marketplace' }));
    expect(peekStashedInstallIntent()).toBeNull();
    expect(takeStashedInstallIntent()).toBeNull();
  });

  it('refuses to stash an intent with no app slug', () => {
    stashPendingInstallIntent({ appSlug: '   ', storeId: 'ci-marketplace' });
    expect(peekStashedInstallIntent()).toBeNull();
  });

  it('trims padded fields and normalises a blank deviceId to null', () => {
    stashPendingInstallIntent({ appSlug: ' immich ', storeId: ' ci-marketplace ', deviceId: '  ' });
    expect(peekStashedInstallIntent()).toEqual({ appSlug: 'immich', storeId: 'ci-marketplace', deviceId: null });
  });

  it('keeps a deviceId when the link targets a specific Hub', () => {
    stashPendingInstallIntent({ appSlug: 'immich', storeId: 'ci-marketplace', deviceId: ' dev-1 ' });
    expect(peekStashedInstallIntent()?.deviceId).toBe('dev-1');
  });

  it('does not auto-open for a stashed intent from a different store', () => {
    stashPendingInstallIntent({ appSlug: 'immich', storeId: 'other-store' });
    expect(shouldAutoOpenInstall('immich', 'ci-marketplace', '')).toBe(false);
  });

  it('ignores an install flag that is not exactly 1', () => {
    expect(shouldAutoOpenInstall('immich', 'ci-marketplace', '?install=0')).toBe(false);
    expect(shouldAutoOpenInstall('immich', 'ci-marketplace', '?install=true')).toBe(false);
  });

  describe('forgetting a link the app page acted on', () => {
    it('clears the stash and empties the copy the desktop shell parked', async () => {
      // Left parked, the next page load took the link again and reopened the install dialog.
      win.__TAURI_INTERNALS__ = {};
      core.invoke.mockResolvedValueOnce({ appSlug: 'immich', storeId: 'ci-marketplace' });
      stashPendingInstallIntent({ appSlug: 'immich', storeId: 'ci-marketplace' });

      await forgetInstallIntentForApp('immich', 'ci-marketplace');

      expect(core.invoke).toHaveBeenCalledWith('consume_pending_install_intent');
      expect(peekStashedInstallIntent()).toBeNull();
      expect(shouldAutoOpenInstall('immich', 'ci-marketplace', '')).toBe(false);
    });

    it("keeps a parked link for another app, for that app's page", async () => {
      win.__TAURI_INTERNALS__ = {};
      core.invoke.mockResolvedValueOnce({ appSlug: 'plane', storeId: 'ci-marketplace' });
      stashPendingInstallIntent({ appSlug: 'immich', storeId: 'ci-marketplace' });

      await forgetInstallIntentForApp('immich', 'ci-marketplace');

      expect(peekStashedInstallIntent()).toEqual({ appSlug: 'plane', storeId: 'ci-marketplace', deviceId: null });
    });

    it('treats the same app in another store as another link', async () => {
      win.__TAURI_INTERNALS__ = {};
      core.invoke.mockResolvedValueOnce({ appSlug: 'immich', storeId: 'other-store' });

      await forgetInstallIntentForApp('immich', 'ci-marketplace');

      expect(peekStashedInstallIntent()).toEqual({ appSlug: 'immich', storeId: 'other-store', deviceId: null });
    });

    it('only clears the stash in a plain browser, where nothing is parked', async () => {
      stashPendingInstallIntent({ appSlug: 'immich', storeId: 'ci-marketplace' });

      await forgetInstallIntentForApp('immich', 'ci-marketplace');

      expect(peekStashedInstallIntent()).toBeNull();
      expect(core.invoke).not.toHaveBeenCalled();
    });
  });
});
