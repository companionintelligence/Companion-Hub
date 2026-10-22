import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  describeRestoreFailure,
  opensRestorePage,
  setupRoute,
  splitRestoreSummary,
  storePathFor,
  summaryIsSettling,
  type RestoreStatus,
} from './restore-status';

const status = (overrides: Partial<RestoreStatus> = {}): RestoreStatus => ({
  completed: false,
  restoreIntent: false,
  checking: false,
  noticePending: false,
  ...overrides,
});

const describe_ = (failure: Parameters<typeof describeRestoreFailure>[2]) =>
  describeRestoreFailure(i18next.t.bind(i18next), (key) => i18next.exists(key), failure);

describe('opensRestorePage', () => {
  /*
   * The Hub restored on its own after pairing. The person signing in never chose "Restore existing
   * device" in this browser. They used to get the setup wizard on a Hub that already had its apps.
   */
  it('opens for a restore nobody has seen, whatever this browser stored', () => {
    expect(opensRestorePage(status({ completed: true, noticePending: true }), null)).toBe(true);
    expect(opensRestorePage(status({ completed: true, noticePending: true }), 'fresh')).toBe(true);
  });

  it('still opens in the tab that chose Restore while that restore has not finished', () => {
    expect(opensRestorePage(status(), 'restore')).toBe(true);
    expect(opensRestorePage(status({ completed: true }), 'restore')).toBe(false);
  });

  it('lets a tab go once its person has seen the restore, even when the Hub could not record that', () => {
    expect(opensRestorePage(status({ completed: true, noticePending: true }), null, true)).toBe(false);
  });

  it('stays out of the way otherwise', () => {
    expect(opensRestorePage(status({ completed: true }), null)).toBe(false);
    expect(opensRestorePage(null, 'restore')).toBe(false);
  });
});

describe('setupRoute', () => {
  it('waits for the apps check before the setup wizard, which would offer apps about to come back', () => {
    expect(setupRoute(status({ checking: true }))).toBe('/restore-apps');
    expect(setupRoute(status())).toBe('/onboarding');
    expect(setupRoute(null)).toBe('/onboarding');
  });
});

describe('describeRestoreFailure', () => {
  it('names the settings an install form was missing, which the CI Account does not keep', () => {
    expect(describe_({ reason: 'APP_INSTALL_FORM_ERROR_INVALID', code: 'failed', params: { fields: 'Admin Password' } })).toBe(
      "It needs settings your CI Account doesn't keep: Admin Password. Install it from the App Store to fill them in.",
    );
    expect(describe_({ reason: 'APP_INSTALL_FORM_ERROR_INVALID', code: 'failed' })).toBe(
      "It needs settings your CI Account doesn't keep. Install it from the App Store to fill them in.",
    );
  });

  it('says why a refused or unlisted app was left out', () => {
    expect(describe_({ reason: 'APP_ACTION_GRANT_DENIED', code: 'refused' })).toBe('You are not allowed to install this app.');
    expect(describe_({ reason: 'No matching marketplace app found for Portal application', code: 'unlisted' })).toBe(
      "This Hub's app store has no listing for it, so it can't be installed here.",
    );
  });

  it('reads any other message key and passes plain text through', () => {
    expect(describe_({ reason: 'APP_INSTALL_FORM_ERROR_DOMAIN_UNAVAILABLE', code: 'failed' })).toBe(
      "We can't serve any more apps from this domain. Pick another domain name to host this app.",
    );
    expect(describe_({ reason: 'socket hang up', code: 'failed' })).toBe('socket hang up');
  });
});

describe('storePathFor', () => {
  it('links an app to its App Store page', () => {
    expect(storePathFor('kimai:ci-marketplace')).toBe('/store/ci-marketplace/kimai');
    expect(storePathFor(undefined)).toBeNull();
    expect(storePathFor('kimai')).toBeNull();
  });
});

describe('summaryIsSettling', () => {
  it('is true while a restored app is still on its way up', () => {
    const app = (status: string) => ({ name: 'Excalidraw', urn: 'excalidraw:ci-marketplace', status, usesAi: false });
    const summary = (statuses: string[]) => ({ completedAt: '', restored: statuses.map(app), notRestored: [], aiModelChosen: false });

    expect(summaryIsSettling(summary(['running', 'installing']))).toBe(true);
    expect(summaryIsSettling(summary(['running', 'install_failed']))).toBe(false);
    expect(summaryIsSettling(null)).toBe(false);
  });
});

describe('splitRestoreSummary', () => {
  /*
   * The Hub lists every install it queued as restored, with the app's status now. An image that could not
   * be pulled leaves the row at install_failed, and the page used to list that app under "Restored" and
   * title the page "Your apps are back on this Hub" when none was.
   */
  it('lists an install that failed after it was queued with the apps that were not restored', () => {
    const app = (name: string, status: string) => ({ name, urn: `${name.toLowerCase()}:ci-marketplace`, status, usesAi: false });
    const split = splitRestoreSummary({
      completedAt: '',
      restored: [app('Excalidraw', 'running'), app('CyberChef', 'install_failed'), app('Wiki', 'missing'), app('Paperless', 'installing')],
      notRestored: [{ name: 'Kimai', urn: 'kimai:ci-marketplace', reason: 'APP_INSTALL_FORM_ERROR_INVALID', code: 'failed' }],
      aiModelChosen: false,
    });

    expect(split.restored.map((entry) => entry.name)).toEqual(['Excalidraw', 'Paperless']);
    expect(split.notRestored.map((entry) => entry.name)).toEqual(['Kimai', 'CyberChef', 'Wiki']);
    expect(split.notRestored[1]).toEqual({
      name: 'CyberChef',
      urn: 'cyberchef:ci-marketplace',
      reason: 'RESTORE_APPS_REASON_INSTALL_FAILED',
      code: 'failed',
    });
    expect(describe_(split.notRestored[1] as Parameters<typeof describeRestoreFailure>[2])).toBe(
      'Its install failed after the restore started it. Open it in the App Store to install it again.',
    );
  });
});
