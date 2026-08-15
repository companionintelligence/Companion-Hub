import { DOCKER_HUB_API_PORT, LOCAL_SOURCE_DEV_API_PORT, LOCAL_SOURCE_DEV_FRONTEND_PORT } from '@/lib/tauri-hub-probe';

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Vite `:5005` or source Nest `:5004` — never a leftover Docker Hub on `:5002`. */
export function isLocalSourceDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return false;
    const port = Number(url.port);
    return port === LOCAL_SOURCE_DEV_FRONTEND_PORT || port === LOCAL_SOURCE_DEV_API_PORT;
  } catch {
    return false;
  }
}

/**
 * Where Companion Account SSO (`/api/auth/portal/start`) must run.
 *
 *  - iOS / Android app: the chosen remote Hub (never localhost).
 *  - macOS / Linux / Windows `local:desktop`: Vite `:5005` (proxies to `:5004`).
 *  - Packaged desktop: the probed Hub API (usually `:5002`).
 *  - Browser on a Hub (any OS, including a phone browser): the page origin.
 *
 * A leftover Docker Hub on `:5002` must not win while the UI is on `:5005`.
 */
export function resolvePortalSsoBaseUrl(input: {
  remoteHubUrl?: string | null;
  isTauriDesktop: boolean;
  configuredApiBaseUrl?: string | null;
  pageOrigin: string;
}): string {
  const remote = input.remoteHubUrl?.trim().replace(/\/+$/, '');
  if (remote) return remote;

  if (isLocalSourceDevOrigin(input.pageOrigin)) {
    return input.pageOrigin.replace(/\/+$/, '');
  }

  if (input.isTauriDesktop) {
    const configured = input.configuredApiBaseUrl?.trim().replace(/\/+$/, '');
    if (configured) return configured;
    return `http://127.0.0.1:${DOCKER_HUB_API_PORT}`;
  }

  return input.pageOrigin.replace(/\/+$/, '');
}

/**
 * Native Hub SSO (iOS/Android `/login` or Mac/Linux/Windows Tauri) returns via
 * `cihub://` / `cihub-dev://`. Browsers stay on the Hub. Cloud-connect PKCE
 * (`/connect`) does not use this — that is `oidc.ts`.
 */
export function shouldUsePortalDesktopHandoff(input: { isTauriDesktop: boolean; isMobileClient: boolean }): boolean {
  return input.isTauriDesktop || input.isMobileClient;
}

/**
 * iOS/Android *Hub* SSO (`mobile-hub-sso`) must not navigate the WKWebView.
 * macOS/Linux/Windows desktop uses a normal `<a href>` — never also call
 * `openAuthInSystemBrowser` (that opens a second tab). Cloud-connect PKCE
 * opens Safari from `oidc.ts`, not from the login form.
 */
export function shouldOpenPortalSsoInSystemBrowser(isMobileClient: boolean): boolean {
  return isMobileClient;
}

/** Same Hub host as {@link buildPortalSsoStartUrl} — the one-time token is stored there. */
export function buildPortalDesktopExchangeUrl(input: {
  token: string;
  remoteHubUrl?: string | null;
  isTauriDesktop: boolean;
  isMobileClient: boolean;
  configuredApiBaseUrl?: string | null;
  pageOrigin: string;
}): string {
  const baseUrl = resolvePortalSsoBaseUrl({
    remoteHubUrl: input.remoteHubUrl,
    isTauriDesktop: input.isTauriDesktop,
    configuredApiBaseUrl: input.configuredApiBaseUrl,
    pageOrigin: input.pageOrigin,
  });
  const url = new URL('/api/auth/portal/desktop-exchange', baseUrl);
  url.searchParams.set('token', input.token);
  return url.toString();
}

export function buildPortalSsoStartUrl(input: {
  remoteHubUrl?: string | null;
  isTauriDesktop: boolean;
  isMobileClient: boolean;
  configuredApiBaseUrl?: string | null;
  pageOrigin: string;
  redirectUrl?: string | null;
}): string {
  const baseUrl = resolvePortalSsoBaseUrl({
    remoteHubUrl: input.remoteHubUrl,
    isTauriDesktop: input.isTauriDesktop,
    configuredApiBaseUrl: input.configuredApiBaseUrl,
    pageOrigin: input.pageOrigin,
  });
  const url = new URL('/api/auth/portal/start', baseUrl);
  const redirectUrl = input.redirectUrl?.trim();
  if (redirectUrl) {
    url.searchParams.set('redirect_url', redirectUrl);
  }
  if (shouldUsePortalDesktopHandoff(input)) {
    url.searchParams.set('desktop', '1');
  }
  return url.toString();
}
