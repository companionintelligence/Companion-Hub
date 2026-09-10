import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractBearerToken, portalClaimsIdentity, resetPortalJwksCacheForTests, verifyPortalIdToken } from '../portal-token';

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
  it('returns claims when jose verifies the token', async () => {
    const verify = vi.fn().mockResolvedValue({
      payload: { sub: 'user-1', email: 'op@example.com', name: 'Op' },
    });
    const createJwks = vi.fn().mockReturnValue({});

    const claims = await verifyPortalIdToken('tok', {
      publicCiCloudUrl: 'https://hub.ci.computer',
      verify: verify as never,
      createJwks: createJwks as never,
    });

    expect(claims).toEqual({ sub: 'user-1', email: 'op@example.com', name: 'Op' });
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
