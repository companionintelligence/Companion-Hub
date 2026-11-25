import { describe, expect, it } from 'vitest';
import { mintSessionHandoffNonce, mintSessionToken, openSessionToken, sessionHandoffCookie, withSessionTokenFragment } from '../session-token';

const SECRET = 'jwt-secret';
const SID = '5f0e8c1a-3b2d-4e6f-9a7b-1c2d3e4f5a6b';

describe('session tokens', () => {
  it('opens the token it minted to the session id', () => {
    expect(openSessionToken(mintSessionToken(SID, SECRET), SECRET)).toBe(SID);
  });

  /* What an app on another port of the Hub's host holds: the bare id, from the cookie. */
  it('opens nothing from a bare session id', () => {
    expect(openSessionToken(SID, SECRET)).toBeNull();
  });

  it.each([
    ['a forged signature', `${SID}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`],
    ['another session’s signature', `${SID}.${mintSessionToken('other-session', SECRET).split('.')[1]}`],
    ['another Hub’s token', mintSessionToken(SID, 'another-hubs-secret')],
    ['an empty signature', `${SID}.`],
    ['only a signature', `.${mintSessionToken(SID, SECRET).split('.')[1]}`],
    ['a non-string', 42],
  ])('opens nothing from %s', (_label, token) => {
    expect(openSessionToken(token, SECRET)).toBeNull();
  });

  it('opens nothing, and mints nothing, without a secret', () => {
    expect(openSessionToken(mintSessionToken(SID, SECRET), undefined)).toBeNull();
    expect(() => mintSessionToken(SID, '')).toThrow();
  });
});

describe('withSessionTokenFragment', () => {
  const HUB = 'https://hub.example.com';
  const fragmentOf = (url: string) => new URL(url).hash;

  it('puts the token in the fragment of a Hub page, replacing any fragment it had', () => {
    const url = withSessionTokenFragment('/settings?tab=auth#old', 'sid.sig', HUB, 'n0');
    expect(url).toBe('https://hub.example.com/settings?tab=auth#ci_hub_session=sid.sig&ci_hub_nonce=n0');
  });

  it('keeps an absolute URL on the Hub', () => {
    expect(withSessionTokenFragment(`${HUB}/home`, 'sid.sig', HUB, 'n0')).toBe(`${HUB}/home#ci_hub_session=sid.sig&ci_hub_nonce=n0`);
  });

  /* Whatever page the browser ends on can read its fragment. */
  it.each([
    ['an app’s host', 'https://ci-hermes.example.com/chat'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['an API route that redirects onward', '/api/auth/portal/start?redirect_url=x'],
    ['another API route', '/api/apps'],
  ])('never hands the token to %s: lands on /home', (_label, url) => {
    const landed = new URL(withSessionTokenFragment(url, 'sid.sig', HUB, 'n0'));
    expect(landed.origin).toBe(HUB);
    expect(landed.pathname).toBe('/home');
    expect(landed.search).toBe('');
    expect(fragmentOf(landed.toString())).toBe('#ci_hub_session=sid.sig&ci_hub_nonce=n0');
  });

  it.each(['/api/auth/edge-sso?redirect=https%3A%2F%2Fapp.example.com%2F', '/api/memory-connect/start?app=ci-hermes%3Aci-marketplace'])(
    'keeps a route that bounces to a Hub page: %s',
    (url) => {
      expect(withSessionTokenFragment(url, 'sid.sig', HUB, 'n0')).toBe(`${HUB}${url}#ci_hub_session=sid.sig&ci_hub_nonce=n0`);
    },
  );
});

describe('the hand-off cookie', () => {
  // `__Host-` makes the browser refuse one set by any other host, an app on a sibling address included.
  it('is a __Host- cookie for the whole Hub over https, and a plain one over http', () => {
    expect(sessionHandoffCookie(true)).toEqual({ name: '__Host-ci-hub-handoff', path: '/', secure: true });
    expect(sessionHandoffCookie(false)).toEqual({ name: 'ci-hub-handoff', path: '/', secure: false });
  });

  it('holds a fresh URL-safe value each time', () => {
    const values = new Set(Array.from({ length: 50 }, () => mintSessionHandoffNonce()));
    expect(values.size).toBe(50);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it('puts the value beside the token, escaped', () => {
    expect(new URL(withSessionTokenFragment('/home', 'a.b', 'https://hub.example.com', 'x+y/z')).hash).toBe(
      '#ci_hub_session=a.b&ci_hub_nonce=x%2By%2Fz',
    );
  });
});
