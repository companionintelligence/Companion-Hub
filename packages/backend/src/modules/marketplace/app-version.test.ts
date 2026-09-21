import { describe, expect, it } from 'vitest';
import { compareAppVersions, parseAppVersion } from './app-version';

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
