import { describe, expect, it } from 'vitest';
import { compareAppVersions, hasUpdateAvailable, parseAppVersion } from './app-version';

describe('parseAppVersion', () => {
  it('parses date-shaped release tags, dot-separated integers', () => {
    expect(parseAppVersion('2026.9.14')).toEqual([2026, 9, 14]);
    expect(parseAppVersion('2026.9.21.1')).toEqual([2026, 9, 21, 1]);
  });

  it('strips a leading v — CI-Hermes tags this way', () => {
    expect(parseAppVersion('v2026.8.9')).toEqual([2026, 8, 9]);
    expect(parseAppVersion('V1.2.3')).toEqual([1, 2, 3]);
  });

  it('parses a plain semver-shaped version too', () => {
    expect(parseAppVersion('0.2.71')).toEqual([0, 2, 71]);
  });

  it('is null for anything that is not a clean dot-integer string — never a guess', () => {
    expect(parseAppVersion(null)).toBeNull();
    expect(parseAppVersion(undefined)).toBeNull();
    expect(parseAppVersion('')).toBeNull();
    expect(parseAppVersion('latest')).toBeNull();
    expect(parseAppVersion('2026.9.1-beta.1')).toBeNull();
    expect(parseAppVersion('v')).toBeNull();
  });
});

describe('compareAppVersions', () => {
  it('the exact case that broke: 2026.9.14 vs 2026.9.21.1 — Number() made both sides NaN', () => {
    expect(Number('2026.9.14')).toBeNaN();
    expect(Number('2026.9.21.1')).toBeNaN();
    expect(compareAppVersions('2026.9.14', '2026.9.21.1')).toBeLessThan(0);
  });

  it('a missing trailing component reads as 0 — 2026.9.21 < 2026.9.21.1', () => {
    expect(compareAppVersions('2026.9.21', '2026.9.21.1')).toBeLessThan(0);
    expect(compareAppVersions('2026.9.21.1', '2026.9.21')).toBeGreaterThan(0);
  });

  it('compares numerically, not lexicographically: 2026.9.9 < 2026.9.14', () => {
    expect(compareAppVersions('2026.9.9', '2026.9.14')).toBeLessThan(0);
    // A string compare would get this backwards: "9" > "14" byte-wise.
    expect('9'.localeCompare('14')).toBeGreaterThan(0);
  });

  it('equal versions compare equal, v-prefix or not', () => {
    expect(compareAppVersions('2026.9.14', '2026.9.14')).toBe(0);
    expect(compareAppVersions('v2026.8.9', '2026.8.9')).toBe(0);
  });

  it('is null — not 0, not a guessed ordering — when either side is unparseable', () => {
    expect(compareAppVersions('latest', '2026.9.14')).toBeNull();
    expect(compareAppVersions('2026.9.14', null)).toBeNull();
    expect(compareAppVersions(undefined, undefined)).toBeNull();
  });
});

describe('hasUpdateAvailable', () => {
  const same = { installedCounter: 1, latestCounter: 1, installedVersion: '2026.9.14', latestVersion: '2026.9.14' };

  it('is false when neither the counter nor the image version moved', () => {
    expect(hasUpdateAvailable(same)).toBe(false);
  });

  it('is true when only the schema counter went up', () => {
    expect(hasUpdateAvailable({ ...same, latestCounter: 2 })).toBe(true);
  });

  it('is true when only the image version went up — the counter sits at 1 for apps that never set it', () => {
    expect(hasUpdateAvailable({ ...same, latestVersion: '2026.9.21.1' })).toBe(true);
  });

  it('is false when the installed image is newer than the catalog', () => {
    expect(hasUpdateAvailable({ ...same, installedVersion: '2026.9.21.1', latestVersion: '2026.9.14' })).toBe(false);
  });

  it('is false for a counter bump the operator ignored', () => {
    expect(hasUpdateAvailable({ ...same, latestCounter: 2, ignoredCounter: 2 })).toBe(false);
  });

  it('still reports a counter bump newer than the one that was ignored', () => {
    expect(hasUpdateAvailable({ ...same, latestCounter: 3, ignoredCounter: 2 })).toBe(true);
  });

  it('does not let an ignored counter silence an image bump', () => {
    expect(hasUpdateAvailable({ ...same, latestCounter: 2, ignoredCounter: 2, latestVersion: '2026.9.21.1' })).toBe(true);
  });

  it('reads an unparseable or missing version as no update rather than guessing', () => {
    expect(hasUpdateAvailable({ ...same, latestVersion: 'latest' })).toBe(false);
    expect(hasUpdateAvailable({ ...same, installedVersion: undefined })).toBe(false);
    expect(hasUpdateAvailable({ ...same, latestVersion: null, latestCounter: undefined })).toBe(false);
  });
});
