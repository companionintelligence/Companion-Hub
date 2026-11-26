import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applianceAudienceRefusal,
  extractBearerToken,
  portalClaimsIdentity,
  resetPortalJwksCacheForTests,
  verifyPortalIdToken,
} from '../portal-token';

afterEach(() => {
  resetPortalJwksCacheForTests();
  vi.unstubAllEnvs();
});

describe('extractBearerToken', () => {
  it('reads a Bearer token', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
  });

  it('returns null for missing or non-Bearer auth', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('')).toBeNull();
  });
});

describe('portalClaimsIdentity', () => {
  it('prefers email over sub', () => {
    expect(portalClaimsIdentity({ sub: 's1', email: 'a@b.c', name: null })).toBe('a@b.c');
    expect(portalClaimsIdentity({ sub: 's1', email: null, name: null })).toBe('s1');
  });

  it('lower-cases the email so Bearer and cookie traffic sign the SAME X-CI-Hub-User', () => {
    // Local usernames are lower-cased on insert, so the cookie path always signs the lower-cased
    // address. A raw `Owner@Example.com` here made the same person two users to the app.
    expect(portalClaimsIdentity({ sub: 's1', email: 'Owner@Example.com', name: null })).toBe('owner@example.com');
  });

  it('trims the claim as well as folding it, because `normalizeUsername` trims', () => {
    // A padded claim that is only lower-cased is still a different string from the stored username,
    // and would put raw whitespace inside the signed header value.
    expect(portalClaimsIdentity({ sub: 's1', email: '  Owner@Example.com  ', name: null })).toBe('owner@example.com');
    expect(portalClaimsIdentity({ sub: 's1', email: '   ', name: null })).toBe('s1');
  });
});

describe('verifyPortalIdToken', () => {
  // Portal's addressing contract: the client id first in `aud`, the appliance after it, and the stamp.
  it('reads the appliance Portal addressed the token to, and the contract version it was minted under', async () => {
    const verify = vi.fn().mockResolvedValue({
      payload: { sub: 'user-1', aud: ['ci-hub', 'urn:ci:device:dev-1'], ci_appliance_binding: 2, email_verified: true },
    });
    resetPortalJwksCacheForTests();

    const claims = await verifyPortalIdToken('tok', {
      publicCiCloudUrl: 'https://hub.ci.computer',
      verify: verify as never,
      createJwks: vi.fn().mockReturnValue({}) as never,
    });

    expect(claims).toMatchObject({ audiences: ['ci-hub', 'urn:ci:device:dev-1'], applianceBinding: 2 });
  });

  it('returns claims when jose verifies the token', async () => {
    const verify = vi.fn().mockResolvedValue({
      payload: { sub: 'user-1', iss: 'https://hub.ci.computer', email: 'op@example.com', email_verified: true, name: 'Op' },
    });
    const createJwks = vi.fn().mockReturnValue({});

    const claims = await verifyPortalIdToken('tok', {
      publicCiCloudUrl: 'https://hub.ci.computer',
      verify: verify as never,
      createJwks: createJwks as never,
    });

    expect(claims).toEqual({
      sub: 'user-1',
      email: 'op@example.com',
      name: 'Op',
      emailVerified: true,
      issuer: 'https://hub.ci.computer',
      audiences: [],
      applianceBinding: null,
    });
    expect(verify).toHaveBeenCalledWith(
      'tok',
      {},
      expect.objectContaining({
        issuer: 'https://hub.ci.computer',
        audience: expect.arrayContaining(['ci-applet', 'ci-hub']),
      }),
    );
  });

  it('returns null when verification fails', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('ERR_JWT_EXPIRED'));
    const claims = await verifyPortalIdToken('tok', {
      publicCiCloudUrl: 'https://hub.ci.computer',
      verify: verify as never,
      createJwks: vi.fn().mockReturnValue({}) as never,
    });
    expect(claims).toBeNull();
  });

  it('returns null when CI_CLOUD_URL is empty', async () => {
    const claims = await verifyPortalIdToken('tok', { publicCiCloudUrl: '' });
    expect(claims).toBeNull();
  });
});

describe('applianceAudienceRefusal', () => {
  const claims = (audiences: string[], applianceBinding: number | null = 2) => ({ sub: 's', email: null, name: null, audiences, applianceBinding });

  it('takes a token Portal addressed to this Hub, whatever else it names', () => {
    expect(applianceAudienceRefusal(claims(['ci-hub', 'urn:ci:device:me']), 'me')).toBeNull();
    expect(applianceAudienceRefusal(claims(['ci-hub', 'urn:ci:device:other', 'urn:ci:device:me']), 'me')).toBeNull();
  });

  it('refuses one addressed to another Hub, stamped or not', () => {
    expect(applianceAudienceRefusal(claims(['ci-hub', 'urn:ci:device:other']), 'me')).toBe('addressed-elsewhere');
    expect(applianceAudienceRefusal(claims(['ci-hub', 'urn:ci:device:other'], null), 'me')).toBe('addressed-elsewhere');
  });

  it('refuses a stamped one addressed to no Hub, and takes an unstamped one from an older Portal', () => {
    expect(applianceAudienceRefusal(claims(['ci-hub'], 2), 'me')).toBe('unaddressed');
    expect(applianceAudienceRefusal(claims(['ci-hub'], 3), 'me')).toBe('unaddressed');
    expect(applianceAudienceRefusal(claims(['ci-hub'], 1), 'me')).toBeNull();
    expect(applianceAudienceRefusal(claims(['ci-hub'], null), 'me')).toBeNull();
    expect(applianceAudienceRefusal({ sub: 's', email: null, name: null }, 'me')).toBeNull();
  });

  it('never takes the address of a Hub with no device id', () => {
    expect(applianceAudienceRefusal(claims(['ci-hub', 'urn:ci:device:']), '')).toBe('addressed-elsewhere');
  });
});
