import { describe, expect, it } from 'vitest';
import { castAppUrn, createAppUrn, extractAppUrn } from '../app-helpers';

describe('castAppUrn', () => {
  it('accepts an ordinary app URN', () => {
    expect(castAppUrn('immich:ci-marketplace')).toBe('immich:ci-marketplace');
    expect(castAppUrn('ci-memory:ci-marketplace')).toBe('ci-memory:ci-marketplace');
    expect(castAppUrn('app_1.2:store-3')).toBe('app_1.2:store-3');
  });

  /*
   * ⚠ `_user` IS A REAL STORE SLUG, NOT AN EDGE CASE. It is the built-in
   * per-user namespace (`RESERVED_APP_STORE_SLUGS` / `APPS_FOLDER`) every custom
   * app and every port-expose workload is minted under, and the frontend builds
   * `${appId}:_user` for every route it calls on one. A validator that demands
   * an alphanumeric first character rejects all of them.
   */
  it('accepts the built-in per-user store slug', () => {
    expect(castAppUrn('my-app:_user')).toBe('my-app:_user');
  });

  /*
   * ⚠ THESE ARE REAL STORE SLUGS TOO. `AppStoreService.createAppStore` derives one
   * with `slugify(name, { lower: true, trim: true })`, and without `strict: true`
   * slugify keeps `( ) : ! + $ * @ ~ _ .` — so these are what a hub actually has on
   * disk after a user adds a store by these names. Rejecting them orphans every app
   * in that store: the listing still renders (it never re-validates), but every
   * route the app's page calls throws.
   */
  it.each([
    ['Store (beta)', 'immich:store-(beta)'],
    ['My Store: v2', 'immich:my-store:-v2'],
    ['My_Store!', 'immich:my_store!'],
    ['Store + More', 'immich:store-+-more'],
  ])('accepts the slug a store named %j is stored under', (_name, urn) => {
    expect(castAppUrn(urn)).toBe(urn);
  });

  /*
   * ⚠ AN APP URN IS TWO PATH SEGMENTS, AND IT IS USED AS SUCH. `extractAppUrn`
   * splits it and callers join the halves straight into filesystem paths —
   * `path.join(dataDir, 'backups', appStoreId, appName)` in the backup manager,
   * app data directories, compose files. This function checked only that a colon
   * was present, so a traversal in either half was a valid URN as far as it was
   * concerned, and got as far as the caller's own fencing allowed.
   */
  it.each([
    ['../../..:ci-marketplace', 'traverses in the app name'],
    ['immich:../../..', 'traverses in the store id'],
    ['immich:..', 'names the parent as a store'],
    ['./immich:ci-marketplace', 'is relative'],
    ['im/mich:ci-marketplace', 'contains a separator'],
    ['immich:ci\\marketplace', 'contains a Windows separator'],
    ['immich:', 'has an empty store id'],
    [':ci-marketplace', 'has an empty app name'],
    ['immich', 'has no separator at all'],
    ['-immich:ci-marketplace', 'starts with a dash, which most tools read as a flag'],
    ['immich:ci marketplace', 'contains whitespace, which splits an unquoted word'],
    ['immich:ci\tmarketplace', 'contains a tab'],
    ['.hidden:ci-marketplace', 'starts with a dot, which is what makes `.` and `..` names'],
    ['immich\0:ci-marketplace', 'contains a NUL'],
  ])('refuses %j because it %s', (urn) => {
    expect(() => castAppUrn(urn)).toThrow();
  });
});

describe('extractAppUrn', () => {
  it('splits an app URN into its name and store', () => {
    expect(extractAppUrn(createAppUrn('immich', 'ci-marketplace'))).toEqual({
      appName: 'immich',
      appStoreId: 'ci-marketplace',
    });
  });
});
