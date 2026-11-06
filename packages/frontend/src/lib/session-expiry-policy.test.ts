import { describe, expect, it } from 'vitest';
import { isSessionExpiryExempt } from './session-expiry-policy';

describe('isSessionExpiryExempt', () => {
  it.each([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/session/refresh',
    // Sign in with a DID: a proof that does not verify is answered 401, as a wrong password is.
    '/api/auth/did/verify',
    // Fail-open bridge: a 401 here must not sign the client out mid-click (#944).
    '/api/auth/browser-handoff/mint',
  ])('exempts %s given as a bare path', (path) => {
    expect(isSessionExpiryExempt(path)).toBe(true);
  });

  it('exempts an absolute URL, which is the form a Response carries', () => {
    expect(isSessionExpiryExempt('http://127.0.0.1:5002/api/auth/browser-handoff/mint')).toBe(true);
  });

  // The DID routes used while signed in never answer 401 unless the session is gone, and then the client must sign out.
  it.each([
    '/api/auth/did/link',
    '/api/auth/did/links',
    '/api/auth/did/challenge',
    '/api/auth/did/verify-all',
    '/api/apps',
    '/api/user-context',
    '/api/auth/browser-handoff',
    '/api/memory-connect/apps/x/status',
  ])('does not exempt %s', (path) => {
    expect(isSessionExpiryExempt(path)).toBe(false);
  });

  it('ignores the query string, so an exempt path cannot be smuggled in as a parameter', () => {
    expect(isSessionExpiryExempt('/api/apps?next=/api/auth/login')).toBe(false);
  });

  it('treats an unknown request target as non-exempt, so a real expiry still signs out', () => {
    expect(isSessionExpiryExempt('')).toBe(false);
  });

  it.each(['/api/auth/login-attempts', '/api/auth/logout-all', '/api/auth/browser-handoff/mint-status'])(
    'matches whole path segments, so %s is not exempted by a shorter entry',
    (path) => {
      expect(isSessionExpiryExempt(path)).toBe(false);
    },
  );
});
