import { describe, expect, it } from 'vitest';
import { castAppUrn, createAppUrn, extractAppUrn } from '../app-helpers';

describe('castAppUrn', () => {
  it('accepts an ordinary app URN', () => {
    expect(castAppUrn('immich:ci-marketplace')).toBe('immich:ci-marketplace');
    expect(castAppUrn('ci-memory:ci-marketplace')).toBe('ci-memory:ci-marketplace');
    expect(castAppUrn('app_1.2:store-3')).toBe('app_1.2:store-3');
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
    ['-immich:ci-marketplace', 'starts with a dash rather than an alphanumeric'],
    ['immich:ci marketplace', 'contains a space'],
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
