import { describe, expect, it } from 'vitest';
import { RETURN_TO_APP_PATH, hubAppDeepLink, isAppUrnLike, isReturnToAppTarget, returnToAppNext } from './return-to-hub-app';

const HUB = 'https://hub-core-2-myorg.companionintelligence.com';

describe('return-to-hub-app', () => {
  it('builds the return page on the launcher origin, carrying only the app id', () => {
    const next = returnToAppNext(`${HUB}/api/memory-connect/start?app=ci-hermes%3Aci-marketplace`, 'ci-hermes:ci-marketplace');
    expect(next).toBe(`${HUB}${RETURN_TO_APP_PATH}?app=ci-hermes%3Aci-marketplace`);
  });

  it('gives no next for an unusable launcher or app id', () => {
    expect(returnToAppNext('not a url', 'ci-hermes:ci-marketplace')).toBeNull();
    expect(returnToAppNext(`${HUB}/api/memory-connect/start`, '<script>')).toBeNull();
  });

  it('accepts only <name>:<store> app ids', () => {
    expect(isAppUrnLike('ci-hermes:ci-marketplace')).toBe(true);
    expect(isAppUrnLike('plane:ci-marketplace')).toBe(true);
    expect(isAppUrnLike('ci-hermes')).toBe(false);
    expect(isAppUrnLike('../x:y')).toBe(false);
    expect(isAppUrnLike('a:b/c')).toBe(false);
    expect(isAppUrnLike(null)).toBe(false);
  });

  it('links back into the Hub app on that app', () => {
    expect(hubAppDeepLink('ci-hermes:ci-marketplace')).toBe('cihub://intent/app?urn=ci-hermes%3Aci-marketplace');
  });

  it('recognises the return page as a finishing target only on this origin', () => {
    expect(isReturnToAppTarget(`${HUB}${RETURN_TO_APP_PATH}?app=x:y`, HUB)).toBe(true);
    expect(isReturnToAppTarget(`https://elsewhere.example${RETURN_TO_APP_PATH}`, HUB)).toBe(false);
    expect(isReturnToAppTarget('https://ci-hermes-core-2-myorg.companionintelligence.com/', HUB)).toBe(false);
    expect(isReturnToAppTarget(null, HUB)).toBe(false);
  });
});
