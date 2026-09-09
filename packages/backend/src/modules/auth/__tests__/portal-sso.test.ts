import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPortalDesktopDeepLink,
  buildPortalDesktopErrorDeepLink,
  parseDesktopChannel,
  resolvePortalDesktopDeepLinkScheme,
  buildPortalSsoErrorRedirectUrl,
  exchangePortalAuthorizationCode,
  fetchPortalSessionEmail,
  buildPortalDesktopHandoffHtml,
  shouldHandoffPortalLoginToDesktop,
  resolvePortalCallbackUrl,
  resolvePortalRootBounce,
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
    expect(buildPortalDesktopDeepLink('handoff-token', 'dev')).toBe('cihub-dev://auth?token=handoff-token');
  });

  // The packaged app also serves its UI from loopback, so a loopback origin must
  // NOT imply the dev scheme: that handed every production sign-in back on
  // cihub-dev://, which no installer registers.
  it('keeps the packaged scheme for a loopback hub origin', () => {
    expect(buildPortalDesktopDeepLink('handoff-token', 'packaged')).toBe('cihub://auth?token=handoff-token');
    expect(resolvePortalDesktopDeepLinkScheme('packaged')).toBe('cihub');
    expect(resolvePortalDesktopDeepLinkScheme(null)).toBe('cihub');
    expect(resolvePortalDesktopDeepLinkScheme('dev')).toBe('cihub-dev');
  });

  it('treats an unknown or missing channel as packaged', () => {
    expect(parseDesktopChannel('dev')).toBe('dev');
    expect(parseDesktopChannel('packaged')).toBe('packaged');
    expect(parseDesktopChannel(undefined)).toBe('packaged');
    expect(parseDesktopChannel('nonsense')).toBe('packaged');
  });

  it('builds the Tauri deep link for desktop auth errors', () => {
    expect(buildPortalDesktopErrorDeepLink('callback_error')).toBe('cihub://auth?error=callback_error');
    expect(buildPortalDesktopErrorDeepLink('callback_error', 'dev')).toBe('cihub-dev://auth?error=callback_error');
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
        desktopChannel: 'dev',
        errorCode: 'account_mismatch',
        fallbackOrigin: 'http://localhost:5002',
      }),
    ).toBe('cihub-dev://auth?error=account_mismatch');
  });

  it('builds the hub callback URL from the initiating origin', () => {
    expect(resolvePortalCallbackUrl('http://localhost:5002')).toBe('http://localhost:5002/api/auth/portal/callback');
  });

  it('bounces a path-stripped OAuth return onto the Hub callback', () => {
    expect(resolvePortalRootBounce({ code: 'abc', state: 'xyz', desktop: '1' })).toBe('/api/auth/portal/callback?code=abc&state=xyz');
  });

  it('restarts desktop SSO when the browser lands on /?desktop=1 with no code', () => {
    expect(resolvePortalRootBounce({ desktop: '1' })).toBe('/api/auth/portal/start?desktop=1');
    expect(resolvePortalRootBounce({})).toBeNull();
  });

  it('builds an HTML handoff that opens the desktop deep link', () => {
    const html = buildPortalDesktopHandoffHtml('cihub-dev://auth?token=tok-1');
    expect(html).toContain('cihub-dev://auth?token=tok-1');
    expect(html).toContain('Open Companion Hub');
  });

  it('hands loopback SSO to a running Tauri app even without desktop=1', () => {
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: false,
        hubOrigin: 'http://localhost:5005',
        desktopAppPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: false,
        hubOrigin: 'http://localhost:5005',
        desktopAppPresent: false,
      }),
    ).toBe(false);
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: false,
        hubOrigin: 'https://hub-nicemac-devben.companionintelligence.com',
        desktopAppPresent: true,
      }),
    ).toBe(false);
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: true,
        hubOrigin: 'https://hub-nicemac-devben.companionintelligence.com',
        desktopAppPresent: false,
      }),
    ).toBe(true);
  });

  it('exchanges authorization codes for user email via Portal OAuth endpoints', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { access_token: 'access-token' },
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { email: 'operator@example.com', email_verified: true },
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
      emailVerified: true,
      subject: null,
      issuer: 'https://hub.ci.computer',
    });
  });

  it.each([
    ['unverified', false],
    ['absent', undefined],
  ])('refuses a userinfo email whose email_verified is %s', async (_label, emailVerified) => {
    // The Hub decides who its operator is by comparing this address. Accepting it unverified would
    // let anyone claim a Hub by typing its operator's address into a Portal signup form.
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { access_token: 'access-token' },
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { email: 'operator@example.com', email_verified: emailVerified },
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
      reason: 'email_unverified',
      status: 200,
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
