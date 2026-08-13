import { Titlebar } from './components/titlebar/titlebar';
import { HubStatus } from './components/hub-status/hub-status';
import { useUpdateChecker } from './hooks/use-update-checker';
import { Suspense, useEffect, useState } from 'react';
import { Toaster } from 'react-hot-toast';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, redirect, useLocation, useRevalidator } from 'react-router';
import type { Route } from './+types/root';
import { userContext } from './api-client';
import { client } from './api-client/client.gen';
import stylesheet from './app.css?url';
import globalsStylesheet from './styles/globals.css?url';
import { Providers } from './components/providers/providers';
import { I18nProvider } from './components/providers/i18n/i18n-provider';
import { ThemeProvider } from './components/providers/theme/theme-provider';
import { normalizeApiErrorMessage } from './lib/normalize-api-error';
import { TranslatableError } from './types/error.types';
import { clearStaleServerSession, getTauriSessionId } from '@/lib/api-fetch';
import { refreshHubSessionIfDue, setServerSessionRefreshRecommendedAt } from '@/lib/hub-session-refresh';
import { handleSessionExpired } from '@/lib/session-expired';
import { isSessionExpiryExempt } from '@/lib/session-expiry-policy';
import { clearHubConnection, getHubBaseUrlSync, initMobileConnection, isTauriMobileSync } from '@/lib/mobile-connection';
import type { RegistrationStatus } from './lib/registration-status';
import { isRegistrationOperational, requiresDeviceRegistration, requiresPortalRePairing } from './lib/registration-status';
import { resolveRegistrationStatus } from './lib/registration-cache';
import { captureHubException, loadHubSentryDeviceId } from './lib/sentry';
import { configureHubApiPort, probeHealthyHubApiPort } from './lib/tauri-hub-probe';
import { usesCrossOriginDesktopApi } from './lib/hub-runtime-mode';
import i18next from 'i18next';

const safeI18nText = (key: string, fallback: string) => (i18next.isInitialized ? i18next.t(key) : fallback);

/** How long the mobile bootstrap spinner runs before offering a way out. */
const MOBILE_SWITCH_HUB_ESCAPE_MS = 8000;

export function DesktopStartupFallback() {
  // Mobile is a thin client connecting to a *remote* Hub — there's no local API,
  // so the desktop copy would be misleading.
  const isMobile = isTauriMobileSync();
  const message = isMobile
    ? safeI18nText('ROOT_CONNECTING', 'Connecting…')
    : safeI18nText('ROOT_CONNECTING_TO_LOCAL_API', 'Connecting to local API...');

  // Escape hatch: a returning mobile user whose stored Hub is unreachable would
  // otherwise spin here forever (the '/' loader returns null while the Hub's
  // registration status is unavailable, and the only Switch Hub UI lives behind
  // a working Hub session). After a few seconds, offer the Hub picker.
  const [showSwitchHub, setShowSwitchHub] = useState(false);
  useEffect(() => {
    if (!isMobile || !getHubBaseUrlSync()) return;
    const id = window.setTimeout(() => setShowSwitchHub(true), MOBILE_SWITCH_HUB_ESCAPE_MS);
    return () => window.clearTimeout(id);
  }, [isMobile]);

  return (
    <main
      id="root"
      className="safe-area-inset flex min-h-dvh flex-col items-center justify-center gap-4 bg-background text-sm text-muted-foreground"
      role="status"
      aria-busy="true"
    >
      {message}
      {showSwitchHub && (
        <div className="flex flex-col items-center gap-3">
          <span>{safeI18nText('MOBILE_CONNECT_HUB_UNREACHABLE_HINT', "Can't reach your Hub.")}</span>
          <button
            type="button"
            data-testid="startup-switch-hub-btn"
            className="min-h-[44px] rounded-md border border-input px-4 text-foreground transition-colors hover:bg-accent"
            onClick={() => {
              void clearHubConnection().finally(() => window.location.assign('/connect'));
            }}
          >
            {safeI18nText('MOBILE_CONNECT_SWITCH_HUB', 'Switch Hub')}
          </button>
        </div>
      )}
    </main>
  );
}

/** Serialize a non-Error thrown value for a readable Sentry message (avoids "[object Object]"). */
function describeUnknownError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

// Add session header for Tauri release mode (cookies don't work cross-origin over HTTP)
client.interceptors.request.use((request) => {
  const sid = getTauriSessionId();
  if (sid) {
    request.headers.set('X-CI-Hub-Session', sid);
  }
  return request;
});

function truncateForSentry(text: string, max = 300): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return '';
  }
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

client.interceptors.response.use(async (res) => {
  if (res.status >= 400) {
    let data: { message?: string; intlParams?: Record<string, string> } = {};
    let rawBody = '';

    // Try to parse JSON, but handle empty or invalid responses gracefully
    try {
      const text = await res.text();
      rawBody = text;
      if (text) {
        data = JSON.parse(text);
      }
    } catch (_e) {
      // If JSON parsing fails, use a default error message
      const fallbackMessage = i18next.isInitialized ? i18next.t('COMMON_AN_ERROR_OCCURRED') : 'An error occurred';
      data = { message: res.statusText || fallbackMessage };
    }

    const messageKey = normalizeApiErrorMessage(data.message, res.status);
    // Keep `message` as the i18n key for toast/UI (`t(e.message)`). Attach HTTP
    // details separately so Sentry can show the real failing request instead of
    // only "COMMON_AN_ERROR_OCCURRED".
    const bodyForSentry = truncateForSentry(typeof data.message === 'string' && data.message ? data.message : rawBody);
    const error = new TranslatableError(messageKey, data.intlParams ?? {}, {
      status: res.status,
      url: res.url ?? '',
      body: bodyForSentry || undefined,
    });

    if (res.status === 401 && !isSessionExpiryExempt(res.url ?? '')) {
      await handleSessionExpired();
    }

    throw error;
  }

  return res;
});

// Cross-origin desktop (legacy embedded SPA or mobile) uses header auth and API port probing.
// Release desktop loads stack UI at http://127.0.0.1:PORT — same-origin cookies, like browser.
const crossOriginDesktopApi = usesCrossOriginDesktopApi();
const credentialMode: RequestCredentials = crossOriginDesktopApi ? 'omit' : 'include';

client.setConfig({
  credentials: credentialMode,
});

const tauriBaseUrlReady: Promise<void> = crossOriginDesktopApi
  ? (async () => {
      // On mobile there is no local backend — the app is a thin client pointed at
      // a remote Hub the user chose. initMobileConnection() applies any stored Hub
      // baseUrl; when none is set, clientLoader routes the user to /connect.
      const { isMobile } = await initMobileConnection();
      if (isMobile) return;
      const port = await probeHealthyHubApiPort();
      configureHubApiPort(port ?? 5002);
    })()
  : Promise.resolve();

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap' },
  { rel: 'stylesheet', href: stylesheet },
  { rel: 'stylesheet', href: globalsStylesheet },
  { rel: 'icon', type: 'image/x-icon', href: '/icons/favicon.ico' },
  { rel: 'shortcut icon', href: '/icons/favicon.ico' },
  { rel: 'manifest', href: '/icons/site.webmanifest' },
];

type RegistrationLookup = { kind: 'ok'; status: RegistrationStatus } | { kind: 'unavailable' };

/** Set after a successful warm bootstrap so shouldRevalidate can skip redundant work. */
let rootBootstrapWarm = false;

async function loadRegistrationLookup(): Promise<RegistrationLookup> {
  const status = await resolveRegistrationStatus();
  if (status) {
    return { kind: 'ok', status };
  }

  return { kind: 'unavailable' };
}

const AUTH_BOOTSTRAP_PATHS = new Set(['/login', '/register', '/connect', '/device-registration', '/reset-password', '/reset-password/confirm']);

/**
 * Skip re-running registration + user-context on warm authenticated navigations.
 * Still revalidate on auth/registration routes, hard reload (default), and when
 * bootstrap has never completed successfully.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: {
  currentUrl: URL;
  nextUrl: URL;
  formMethod?: string;
  defaultShouldRevalidate: boolean;
}) {
  if (formMethod && formMethod !== 'GET') {
    return true;
  }

  if (AUTH_BOOTSTRAP_PATHS.has(currentUrl.pathname) || AUTH_BOOTSTRAP_PATHS.has(nextUrl.pathname)) {
    rootBootstrapWarm = false;
    return true;
  }

  if (!rootBootstrapWarm) {
    return defaultShouldRevalidate;
  }

  // Warm SPA navigations under the authenticated shell — keep prior loader data.
  if (currentUrl.origin === nextUrl.origin) {
    return false;
  }

  return defaultShouldRevalidate;
}

export async function clientLoader({ request }: Route.ActionArgs) {
  // In Tauri release mode, wait for the backend port probe to complete
  await tauriBaseUrlReady;

  const url = new URL(request.url);

  // On mobile, nothing works until a remote Hub is chosen. Send the user to the
  // connect screen; the connect route itself is exempt so it can render.
  if (isTauriMobileSync() && !getHubBaseUrlSync()) {
    if (url.pathname !== '/connect') {
      return redirect('/connect');
    }
    return null;
  }

  const registration = await loadRegistrationLookup();

  if (registration.kind === 'unavailable') {
    if (url.pathname === '/device-registration' || url.pathname === '/login' || url.pathname === '/') {
      // Stay on the current bootstrap route while the API wakes up. Redirecting `/`
      // to device-registration here caused a flash loop with the registration page,
      // which navigates away as soon as status becomes operational again.
      return null;
    }
  }

  if (registration.kind === 'ok' && requiresDeviceRegistration(registration.status)) {
    if (url.pathname === '/login') {
      return null;
    }
    if (url.pathname !== '/device-registration') {
      return redirect('/device-registration');
    }
    return null;
  }

  // A registered Hub whose public tunnel is degraded (tunnel_token_missing) is
  // still fully usable locally. Don't hijack every navigation to the re-pair
  // screen — that locks the user out of Settings and other local pages. The
  // state is surfaced in-app via the dashboard banner (TunnelStatusBanner),
  // and the user can open the re-pair screen from there when they choose to.
  if (
    registration.kind === 'ok' &&
    isRegistrationOperational(registration.status) &&
    !requiresPortalRePairing(registration.status) &&
    url.pathname === '/device-registration'
  ) {
    return redirect('/login');
  }

  // Now check user context for auth/onboarding flow.
  // In desktop startup races the API may be temporarily unavailable even when
  // containers are still booting; avoid throwing into the route ErrorBoundary.
  let userResult: Awaited<ReturnType<typeof userContext>> | null = null;
  try {
    userResult = await userContext();
    if (userResult.data?.isLoggedIn) {
      setServerSessionRefreshRecommendedAt(userResult.data.sessionRefreshRecommendedAt ?? null);
      await refreshHubSessionIfDue();
    } else {
      await clearStaleServerSession();
      rootBootstrapWarm = false;
    }
  } catch {
    rootBootstrapWarm = false;
    // Tauri opens at `/` with no matching child route. Never leave the user on a
    // blank outlet — send them somewhere that renders UI while the backend wakes up.
    if (url.pathname === '/') {
      return redirect('/login');
    }
    return null;
  }

  if (registration.kind === 'ok' && isRegistrationOperational(registration.status) && userResult.data?.isLoggedIn) {
    rootBootstrapWarm = true;
  } else if (registration.kind === 'ok' && requiresDeviceRegistration(registration.status)) {
    rootBootstrapWarm = false;
  }

  // Non-root paths: let individual route loaders handle redirects
  if (url.pathname !== '/') {
    return userResult;
  }

  // Root path: determine where to send the user
  if (!userResult.data?.isConfigured) {
    return redirect('/login');
  }

  if (!userResult.data?.isLoggedIn && !userResult.data?.isGuestDashboardEnabled) {
    return redirect('/login');
  }

  // Carry a memory-connect result marker (set by the Hub's memory-connect start/
  // callback redirects at `/?memoryConnect=…`) across this root→/home hop so the
  // dashboard can surface it as a toast; without this the query is dropped here.
  // Whitelisted values only, so arbitrary query junk is never reflected onward.
  const memoryConnect = url.searchParams.get('memoryConnect');
  if (memoryConnect === 'error' || memoryConnect === 'unavailable') {
    return redirect(`/home?memoryConnect=${memoryConnect}`);
  }

  return redirect('/home');
}

export function Layout({ children }: { children: React.ReactNode }) {
  useUpdateChecker();
  const [apiReady, setApiReady] = useState(() => !crossOriginDesktopApi);
  const [documentTitle, setDocumentTitle] = useState(() => (i18next.isInitialized ? i18next.t('APP_NAME') : 'CI Hub'));
  const [documentLang, setDocumentLang] = useState(() => i18next.resolvedLanguage || i18next.language || 'en');

  useEffect(() => {
    if (!crossOriginDesktopApi) return;

    let cancelled = false;
    void tauriBaseUrlReady.then(() => {
      if (!cancelled) {
        setApiReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!apiReady) {
      return;
    }

    void loadHubSentryDeviceId();
  }, [apiReady]);

  useEffect(() => {
    const syncDocumentTitle = () => {
      setDocumentTitle(i18next.isInitialized ? i18next.t('APP_NAME') : 'CI Hub');
      setDocumentLang(i18next.resolvedLanguage || i18next.language || 'en');
    };

    syncDocumentTitle();
    i18next.on('initialized', syncDocumentTitle);
    i18next.on('languageChanged', syncDocumentTitle);
    i18next.on('loaded', syncDocumentTitle);

    return () => {
      i18next.off('initialized', syncDocumentTitle);
      i18next.off('languageChanged', syncDocumentTitle);
      i18next.off('loaded', syncDocumentTitle);
    };
  }, []);

  useEffect(() => {
    const RELOAD_GUARD_KEY = 'ci-hub-preload-error-reload';
    const handlePreloadError = () => {
      // A failed asset preload is usually a stale chunk hash after an update or a
      // corrupt WebView2 disk cache surfacing as ERR_CACHE_READ_FAILURE — a single
      // reload recovers it. Guard with sessionStorage so a persistently
      // unfetchable asset cannot trap the app in an infinite reload loop.
      try {
        if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return;
        sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
      } catch {
        // sessionStorage unavailable (private mode / disabled) — fall back to
        // window.name, which also survives a same-window reload, so the recovery
        // reload still happens at most once instead of looping forever.
        const nameGuard = `|${RELOAD_GUARD_KEY}|`;
        if (window.name.includes(nameGuard)) return;
        window.name = `${window.name}${nameGuard}`;
      }
      window.location.reload();
    };
    window.addEventListener('vite:preloadError', handlePreloadError);

    return () => {
      window.removeEventListener('vite:preloadError', handlePreloadError);
    };
  }, []);

  // Dev-mode safeguard: if the dev server / HMR leaves the page in a skeletal state
  // (empty main#root) show a small overlay with a reload button so users don't see a plain blank page.
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const checkAndShow = () => {
      try {
        const main = document.getElementById('root');
        if (!main) return;
        const text = (main.innerText || '').trim();
        const shouldShow = text.length === 0 && location.pathname !== '/login';
        if (shouldShow) {
          if (!document.getElementById('ci-hub-dev-fallback')) {
            const fallbackLabel = i18next.t('ROOT_DEV_UI_MODULES_NOT_LOADED');
            const reloadLabel = i18next.t('COMMON_RELOAD');
            const el = document.createElement('div');
            el.id = 'ci-hub-dev-fallback';
            el.style.position = 'fixed';
            el.style.top = '12px';
            el.style.right = '12px';
            el.style.zIndex = '2147483647';
            el.style.background = 'rgba(0,0,0,0.7)';
            el.style.color = '#fff';
            el.style.padding = '8px 12px';
            el.style.borderRadius = '8px';
            el.style.fontSize = '13px';
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.gap = '8px';
            wrapper.style.alignItems = 'center';

            const label = document.createElement('span');
            label.textContent = fallbackLabel;

            const button = document.createElement('button');
            button.id = 'ci-hub-dev-reload';
            button.type = 'button';
            button.style.background = '#fff';
            button.style.color = '#000';
            button.style.border = 'none';
            button.style.padding = '6px 8px';
            button.style.borderRadius = '6px';
            button.style.cursor = 'pointer';
            button.textContent = reloadLabel;
            button.addEventListener('click', () => location.reload());

            wrapper.appendChild(label);
            wrapper.appendChild(button);
            el.appendChild(wrapper);
            document.body.appendChild(el);
          }
        } else {
          const exist = document.getElementById('ci-hub-dev-fallback');
          if (exist) exist.remove();
        }
      } catch (_e) {
        // ignore
      }
    };

    const id = window.setInterval(checkAndShow, 1000);
    checkAndShow();
    return () => {
      window.clearInterval(id);
      const exist = document.getElementById('ci-hub-dev-fallback');
      if (exist) exist.remove();
    };
  }, []);

  return (
    <html lang={documentLang}>
      <head>
        <title>{documentTitle}</title>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body>
        <ThemeProvider defaultTheme="dark">
          {apiReady ? (
            <I18nProvider>
              <Suspense fallback={<DesktopStartupFallback />}>
                <Titlebar />
                <HubStatus>
                  <main id="root">
                    {children}
                    <ScrollRestoration />
                  </main>
                </HubStatus>
              </Suspense>
            </I18nProvider>
          ) : (
            <DesktopStartupFallback />
          )}
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  const { revalidate } = useRevalidator();
  const location = useLocation();
  const onRootBootstrap = location.pathname === '/' && loaderData == null;

  // Root has no index route. While the loader is still resolving (common during
  // desktop startup), keep polling so we redirect off `/` as soon as the API responds.
  useEffect(() => {
    if (!onRootBootstrap) return;

    void revalidate();
    const id = window.setInterval(() => {
      void revalidate();
    }, 1500);
    return () => window.clearInterval(id);
  }, [onRootBootstrap, revalidate]);

  if (onRootBootstrap) {
    return (
      <>
        <DesktopStartupFallback />
        <Toaster position="bottom-center" />
      </>
    );
  }

  return (
    <Providers>
      <Outlet />
      <Toaster position="bottom-center" />
    </Providers>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = safeI18nText('ROOT_ERROR_BOUNDARY_OOPS', 'Oops!');
  let details = safeI18nText('ROOT_ERROR_BOUNDARY_UNEXPECTED_ERROR', 'An unexpected error occurred.');
  let stack: string | undefined;

  if (import.meta.env.DEV) {
    console.error('Route ErrorBoundary captured error:', error);
  } else if (isRouteErrorResponse(error)) {
    // Route error responses are plain objects, not Error instances. Preserve
    // the actionable HTTP fields instead of stringifying to "[object Object]".
    captureHubException(new Error(`Route error ${error.status}: ${error.statusText || 'Unknown'}`), {
      status: error.status,
      statusText: error.statusText,
      data: error.data,
    });
  } else if (error instanceof Error) {
    captureHubException(error);
  } else {
    captureHubException(new Error(`Non-error thrown in route boundary: ${describeUnknownError(error)}`), {
      rawError: error,
    });
  }

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : safeI18nText('COMMON_ERROR', 'Error');
    details =
      error.status === 404
        ? safeI18nText('ROOT_ERROR_BOUNDARY_PAGE_NOT_FOUND', 'The requested page could not be found.')
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
