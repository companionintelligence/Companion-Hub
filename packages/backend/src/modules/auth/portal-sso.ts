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
