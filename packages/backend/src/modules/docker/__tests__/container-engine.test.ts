import { describe, expect, it } from 'vitest';
import { isSocktainerVersion } from '../container-engine';

describe('isSocktainerVersion', () => {
  it('recognises the /version socktainer sends', () => {
    // Shape from socktainer's VersionRoute: platform and component both name it.
    expect(
      isSocktainerVersion({
        Platform: { Name: 'socktainer' },
        Components: [{ Name: 'socktainer', Version: '1.5.0' }],
        ApiVersion: '1.51',
        Os: 'macOS',
        Arch: 'arm64',
      }),
    ).toBe(true);
  });

  it('accepts either field alone, ignoring case and padding', () => {
    expect(isSocktainerVersion({ Platform: { Name: ' Socktainer ' } })).toBe(true);
    expect(isSocktainerVersion({ Components: [{ Name: 'Engine' }, { Name: 'socktainer' }] })).toBe(true);
  });

  it('does not match Docker Engine or Docker Desktop', () => {
    expect(
      isSocktainerVersion({
        Platform: { Name: 'Docker Engine - Community' },
        Components: [{ Name: 'Engine' }, { Name: 'containerd' }, { Name: 'runc' }],
      }),
    ).toBe(false);
    expect(isSocktainerVersion({ Platform: { Name: 'Docker Desktop 4.40.0 (187762)' }, Components: [{ Name: 'Engine' }] })).toBe(false);
  });

  it('does not match a name that merely contains socktainer', () => {
    expect(isSocktainerVersion({ Platform: { Name: 'not-socktainer-at-all' } })).toBe(false);
  });

  it('is false for anything that is not a version body', () => {
    expect(isSocktainerVersion(undefined)).toBe(false);
    expect(isSocktainerVersion(null)).toBe(false);
    expect(isSocktainerVersion('socktainer')).toBe(false);
    expect(isSocktainerVersion({})).toBe(false);
    expect(isSocktainerVersion({ Platform: { Name: 42 }, Components: 'socktainer' })).toBe(false);
    expect(isSocktainerVersion({ Components: [null, {}] })).toBe(false);
  });
});
