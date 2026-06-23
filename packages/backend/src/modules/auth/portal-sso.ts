import type { Request } from 'express';
import axios from 'axios';
import { buildPortalAxiosConfig, readPortalInternalUrlOverride, resolveOutboundPortalBaseUrl } from '@/common/helpers/portal-url';

export interface PortalSsoState {
  codeVerifier: string;
  redirectUrl: string | null;
  hubOrigin: string;
  desktop: boolean;
}

export interface PortalDesktopExchange {
  sessionId: string;
  redirectPath: string;
}

export function resolveSameOriginRedirectUrl(redirectUrl: string | null | undefined, hubOrigin: string): string | null {
  if (!redirectUrl) {
    return null;
  }

  try {
    const candidate = new URL(redirectUrl);
    const origin = new URL(hubOrigin);
    if (candidate.origin !== origin.origin) {
      return null;
    }
    return candidate.toString();
  } catch {
    return null;
  }
}

export function toDesktopRedirectPath(redirectUrl: string | null | undefined, hubOrigin: string): string {
  const safeRedirect = resolveSameOriginRedirectUrl(redirectUrl, hubOrigin);

  if (!safeRedirect) {
    return '/home';
  }

  const candidate = new URL(safeRedirect);
  return `${candidate.pathname}${candidate.search}${candidate.hash}` || '/home';
}

export function buildPortalDesktopDeepLink(token: string): string {
  const url = new URL('cihub://auth');
  url.searchParams.set('token', token);
  return url.toString();
}

export function resolveHubRequestOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.get('host');

  if (!host) {
    throw new Error('Missing host header');
  }

  return `${proto}://${host}`;
}

export function resolvePortalCallbackUrl(hubOrigin: string): string {
  return new URL('/api/auth/portal/callback', hubOrigin).toString();
}

export interface PortalTokenExchangeResult {
  ok: true;
  accessToken: string;
  email: string;
}

export interface PortalTokenExchangeFailure {
  ok: false;
  reason: 'token_exchange_failed' | 'missing_access_token' | 'userinfo_failed' | 'missing_email' | 'network_error';
  status?: number;
}

export type PortalOAuthExchangeResult = PortalTokenExchangeResult | PortalTokenExchangeFailure;

export async function exchangePortalAuthorizationCode(input: {
  publicPortalBaseUrl: string;
  callbackUrl: string;
  code: string;
  codeVerifier: string;
}): Promise<PortalOAuthExchangeResult> {
  const internalOverride = readPortalInternalUrlOverride();
  const portalBaseUrl = resolveOutboundPortalBaseUrl(input.publicPortalBaseUrl, internalOverride);
  const axiosConfig = buildPortalAxiosConfig(input.publicPortalBaseUrl, internalOverride);

  const tokenUrl = new URL('/api/auth/oauth2/token', portalBaseUrl).toString();
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', 'ci-hub');
  body.set('redirect_uri', input.callbackUrl);
  body.set('code', input.code);
  body.set('code_verifier', input.codeVerifier);

  let tokenRes: { status: number; data: unknown };

  try {
    tokenRes = await axios.post(tokenUrl, body.toString(), {
      ...axiosConfig,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
      timeout: 15_000,
    });
  } catch {
    return { ok: false, reason: 'network_error' };
  }

  if (tokenRes.status < 200 || tokenRes.status >= 300) {
    return { ok: false, reason: 'token_exchange_failed', status: tokenRes.status };
  }

  const accessToken = (tokenRes.data as { access_token?: string } | undefined)?.access_token;
  if (!accessToken) {
    return { ok: false, reason: 'missing_access_token', status: tokenRes.status };
  }

  const userinfoUrl = new URL('/api/auth/oauth2/userinfo', portalBaseUrl).toString();
  let userinfoRes: { status: number; data: unknown };

  try {
    userinfoRes = await axios.get(userinfoUrl, {
      ...axiosConfig,
      headers: { authorization: `Bearer ${accessToken}` },
      validateStatus: () => true,
      timeout: 15_000,
    });
  } catch {
    return { ok: false, reason: 'network_error' };
  }

  if (userinfoRes.status < 200 || userinfoRes.status >= 300) {
    return { ok: false, reason: 'userinfo_failed', status: userinfoRes.status };
  }

  const email = (userinfoRes.data as { email?: string } | undefined)?.email;
  if (!email) {
    return { ok: false, reason: 'missing_email', status: userinfoRes.status };
  }

  return { ok: true, accessToken, email };
}
