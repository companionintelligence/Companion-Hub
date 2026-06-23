import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPortalDesktopDeepLink,
  exchangePortalAuthorizationCode,
  resolvePortalCallbackUrl,
  resolveSameOriginRedirectUrl,
  toDesktopRedirectPath,
} from '../portal-sso';

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
});
