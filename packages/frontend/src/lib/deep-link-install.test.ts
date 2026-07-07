import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildInstallIntentPath,
  clearStashedInstallIntentForApp,
  DEFAULT_INSTALL_STORE_ID,
  peekStashedInstallIntent,
  shouldAutoOpenInstall,
  stashPendingInstallIntent,
  takeStashedInstallIntent,
} from './deep-link-install';

describe('deep-link-install', () => {
  beforeEach(() => {
    sessionStorage.clear();
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
});
