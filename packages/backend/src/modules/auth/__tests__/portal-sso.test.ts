import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPortalDesktopDeepLink,
  buildPortalDesktopErrorDeepLink,
  buildPortalSsoErrorRedirectUrl,
  exchangePortalAuthorizationCode,
  fetchPortalSessionEmail,
  resolvePortalCallbackUrl,
  resolveSameOriginRedirectUrl,
  resolveTrustedReturnOrigin,
  toDesktopRedirectPath,
} from '../portal-sso';
import type { Request } from 'express';

function fakeRequest(headers: Record<string, string>, host?: string, protocol = 'http'): Request {
  return {
    headers,
    protocol,
    get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
  } as unknown as Request;
}

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

describe('portal-sso helpers', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.get).mockReset();
  });

  it('keeps only same-origin redirect URLs', () => {
    expect(resolveSameOriginRedirectUrl('https://hub.example.com/settings?tab=auth', 'https://hub.example.com')).toBe(
      'https://hub.example.com/settings?tab=auth',
    );
    expect(resolveSameOriginRedirectUrl('https://portal.example.com/home', 'https://hub.example.com')).toBeNull();
  });

  it('converts same-origin redirects into in-app paths for desktop handoff', () => {
    expect(toDesktopRedirectPath('https://hub.example.com/settings?tab=auth#portal', 'https://hub.example.com')).toBe('/settings?tab=auth#portal');
    expect(toDesktopRedirectPath('https://portal.example.com/home', 'https://hub.example.com')).toBe('/home');
  });

  it('builds the Tauri deep link for desktop auth handoff', () => {
    expect(buildPortalDesktopDeepLink('handoff-token')).toBe('cihub://auth?token=handoff-token');
  });

  it('builds the Tauri deep link for desktop auth errors', () => {
    expect(buildPortalDesktopErrorDeepLink('callback_error')).toBe('cihub://auth?error=callback_error');
  });

  it('redirects browser portal errors to the login page', () => {
    expect(
      buildPortalSsoErrorRedirectUrl({
        hubOrigin: 'http://localhost:5002',
        desktop: false,
        errorCode: 'state_expired',
        fallbackOrigin: 'http://localhost:5002',
      }),
    ).toBe('http://localhost:5002/login?portal_error=state_expired');
  });

  it('redirects desktop portal errors to the cihub deep link', () => {
    expect(
      buildPortalSsoErrorRedirectUrl({
        hubOrigin: 'http://localhost:5002',
        desktop: true,
        errorCode: 'account_mismatch',
        fallbackOrigin: 'http://localhost:5002',
      }),
    ).toBe('cihub://auth?error=account_mismatch');
  });

  it('builds the hub callback URL from the initiating origin', () => {
    expect(resolvePortalCallbackUrl('http://localhost:5002')).toBe('http://localhost:5002/api/auth/portal/callback');
  });

  it('exchanges authorization codes for user email via Portal OAuth endpoints', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { access_token: 'access-token' },
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { email: 'operator@example.com' },
    });

    await expect(
      exchangePortalAuthorizationCode({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        callbackUrl: 'http://localhost:5002/api/auth/portal/callback',
        code: 'auth-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({
      ok: true,
      accessToken: 'access-token',
      email: 'operator@example.com',
    });
  });

  it('returns a structured failure when token exchange fails', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 400,
      data: { error: 'invalid_grant' },
    });

    await expect(
      exchangePortalAuthorizationCode({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        callbackUrl: 'http://localhost:5002/api/auth/portal/callback',
        code: 'auth-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'token_exchange_failed',
      status: 400,
    });
  });

  describe('resolveTrustedReturnOrigin', () => {
    const trusted = { domain: 'companionintelligence.com', localDomain: 'companionintelligence.com' };

    it('returns the origin for localhost', () => {
      expect(resolveTrustedReturnOrigin(fakeRequest({}, 'localhost:5002'), trusted)).toBe('http://localhost:5002');
    });

    it('returns the origin for the configured domain and its subdomains', () => {
      expect(
        resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub-abc.companionintelligence.com' }), trusted),
      ).toBe('https://hub-abc.companionintelligence.com');
      expect(
        resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'companionintelligence.com' }), trusted),
      ).toBe('https://companionintelligence.com');
    });

    it('omits the origin for untrusted hosts (host header injection)', () => {
      expect(resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-host': 'attacker.example.com' }, 'localhost:5002'), trusted)).toBeUndefined();
      // A lookalike suffix must not match the trusted domain.
      expect(resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-host': 'evilcompanionintelligence.com' }), trusted)).toBeUndefined();
    });

    it('uses only the first value of a comma-separated forwarded host', () => {
      expect(
        resolveTrustedReturnOrigin(
          fakeRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub.companionintelligence.com, attacker.example.com' }),
          trusted,
        ),
      ).toBe('https://hub.companionintelligence.com');
    });

    it('returns undefined when no host is present', () => {
      expect(resolveTrustedReturnOrigin(fakeRequest({}), trusted)).toBeUndefined();
    });
  });

  it('reads the signed-in Portal account email from get-session', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { user: { email: 'portal@example.com' } },
    });

    await expect(
      fetchPortalSessionEmail({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        cookieHeader: 'ci.session=abc',
      }),
    ).resolves.toBe('portal@example.com');
  });
});
