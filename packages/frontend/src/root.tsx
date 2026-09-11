import { Titlebar } from './components/titlebar/titlebar';
import { HubStatus } from './components/hub-status/hub-status';
import { useUpdateChecker } from './hooks/use-update-checker';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Toaster } from 'react-hot-toast';
import { Links, Meta, Navigate, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, redirect, useLocation, useRevalidator } from 'react-router';
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
import {
  getHubBaseUrlSync,
  initMobileConnection,
  isCloudConnectPath,
  isMobileClient,
  needsRemoteHubConnect,
  usesCloudConnect,
} from '@/lib/mobile-connection';
import { shouldTimeBoxMobileLoads } from '@/lib/use-mobile-load-timeout';
import { installMobileLoadWatchdog } from '@/lib/mobile-load-watchdog';
import type { RegistrationStatus } from './lib/registration-status';
import { isRegistrationOperational, requiresDeviceRegistration, requiresPortalRePairing } from './lib/registration-status';
import { resolveRegistrationStatus } from './lib/registration-cache';
import { captureHubException, loadHubSentryDeviceId } from './lib/sentry';
import { configureHubApiPort, probeHealthyHubApiPort } from './lib/tauri-hub-probe';
import { usesCrossOriginDesktopApi } from './lib/hub-runtime-mode';
import { firstOf, HUB_BOOTSTRAP_FETCH_MS, subscribeHubResume } from './lib/hub-resume';
import i18next from 'i18next';

const safeI18nText = (key: string, fallback: string) => (i18next.isInitialized ? i18next.t(key) : fallback);

export function DesktopStartupFallback() {
  // Mobile already has a real screen for this: `/connect` (cloud sign-in) or
  // `/login` (chosen Hub). Do not paint a second unstyled "Connect to your Hub"
  // page — send the user there.
  const isMobile = isMobileClient();
  const hasStoredHub = Boolean(getHubBaseUrlSync());

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;
    const path = window.location.pathname;
    if (isCloudConnectPath(path) || path === '/login') return;
    window.location.replace(hasStoredHub ? '/login' : '/connect');
  }, [isMobile, hasStoredHub]);

  if (isMobile) {
    return <main id="root" className="safe-area-inset min-h-dvh bg-background" role="status" aria-busy="true" />;
  }

  return <ConnectingToLocalApi />;
}

/**
 * Covers the viewport while root `clientLoader` / a Suspense fallback is up.
 * Must be `fixed inset-0`, not an in-flow `min-h-[40vh]` block: on reload of
 * `/store` React Router can keep HydrateFallback mounted as a sibling of App
 * (dummy server `loader()` already returned null, so App renders the store).
 * An in-flow 40vh gate then sits under the fixed dashboard header while the
 * featured catalog — which talks to an API that is already up — paints below.
 */
function ConnectingToLocalApi() {
  const [showRetry, setShowRetry] = useState(false);
  const gateRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Mark the gate React owns. Set in an effect, not in the markup, so the
    // prerendered document still matches; see removeOrphanedStartupGates.
    gateRef.current?.setAttribute(HYDRATED_GATE_ATTR, '');
    const id = globalThis.setTimeout(() => setShowRetry(true), 4_000);
    return () => globalThis.clearTimeout(id);
  }, []);

  return (
    <main
      ref={gateRef}
      data-testid="connecting-to-local-api"
      className="safe-area-inset fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background px-6"
      role="status"
      aria-busy="true"
    >
      <p className="text-sm text-muted-foreground">{safeI18nText('ROOT_CONNECTING_TO_LOCAL_API', 'Connecting to local API...')}</p>
      {showRetry && (
        <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => window.location.reload()}>
          {safeI18nText('COMMON_RELOAD', 'Reload')}
        </button>
      )}
    </main>
  );
}

const HYDRATED_GATE_ATTR = 'data-hydrated';

/**
 * Drop a prerendered startup gate that hydration left behind.
 *
 * When the first client render disagrees with the prerendered document React
 * throws #418 and regenerates the tree on the client. On a plain origin that
 * recovery also clears the server markup, but with a third-party `<script>`
 * injected into `<body>` — Cloudflare's challenge platform does this on every
 * tunnel hostname — the prerendered gate survives as a dead `fixed z-[100]`
 * overlay with the fully working app painted underneath it. The gate React
 * owns marks itself in its own mount effect, which runs before this parent
 * effect; anything still unmarked at body level is that leftover.
 */
export function removeOrphanedStartupGates(root: Document = document) {
  for (const el of root.querySelectorAll(`body > [data-testid="connecting-to-local-api"]:not([${HYDRATED_GATE_ATTR}])`)) {
    el.remove();
  }
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
// Recompute at use-time after initMobileConnection — a module-init snapshot on
// iOS `devUrl` (http://localhost:5005) looks like desktop-same-origin / browser
// and skipped mobile init, leaving the app stuck on a local API that isn't there.
const waitForMobileOrCrossOrigin = isMobileClient() || shouldTimeBoxMobileLoads() || usesCrossOriginDesktopApi();
const credentialMode: RequestCredentials = usesCrossOriginDesktopApi() ? 'omit' : 'include';

client.setConfig({
  credentials: credentialMode,
});

const tauriBaseUrlReady: Promise<void> = (async () => {
  // Always run mobile init. On a phone there is no local backend — the app is a
  // thin client pointed at a remote Hub. When none is stored, clientLoader
  // routes the user to /connect. Previously this block was gated on a
  // module-init `usesCrossOriginDesktopApi()` snapshot and never ran in ios:dev.
  const { isMobile } = await initMobileConnection();
  if (isMobile) return;
  if (!usesCrossOriginDesktopApi()) return;
  const port = await probeHealthyHubApiPort();
  configureHubApiPort(port ?? 5002);
})();

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

/**
 * The stale-cookie logout is one round trip per document, not one per loader
 * pass: a cold load of a protected route runs this loader for the route and
 * again for `/login`, which posted `/api/auth/logout` twice before the login
 * page had painted. Cleared again the moment a live session is observed.
 */
let staleServerSessionCleared = false;

async function loadRegistrationLookup(): Promise<RegistrationLookup> {
  const status = await firstOf(resolveRegistrationStatus(), null, HUB_BOOTSTRAP_FETCH_MS);
  if (status) {
    return { kind: 'ok', status };
  }

  return { kind: 'unavailable' };
}

const AUTH_BOOTSTRAP_PATHS = new Set([
  '/login',
  '/register',
  '/connect',
  '/connect/advanced',
  '/device-registration',
  '/reset-password',
  '/reset-password/confirm',
]);

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

const MOBILE_ROOT_LOADER_MS = 6_000;
const rootLoaderTimeout = Symbol('mobile-root-loader-timeout');

/**
 * SPA prerender (`ssr: false`) still runs a server loader to write index.html.
 * Without this, `clientLoader.hydrate` paints HydrateFallback and React Router
 * treats the shell as a 500 — Hub CI / agent-gates / integration-tests fail.
 */
export function loader() {
  return null;
}

export async function clientLoader({ request }: Route.ActionArgs) {
  if (usesCloudConnect() || import.meta.env.VITE_HUB_RUNTIME === 'mobile') {
    const raced = await Promise.race([
      runClientLoader(request),
      new Promise<typeof rootLoaderTimeout>((resolve) => {
        globalThis.setTimeout(() => resolve(rootLoaderTimeout), MOBILE_ROOT_LOADER_MS);
      }),
    ]);
    if (raced !== rootLoaderTimeout) {
      return raced;
    }
    const url = new URL(request.url);
    if (isCloudConnectPath(url.pathname) || url.pathname === '/login') {
      return null;
    }
    return needsRemoteHubConnect() ? redirect('/connect') : redirect('/login');
  }

  return runClientLoader(request);
}

async function runClientLoader(request: Request) {
  // In Tauri release mode, wait for the backend port probe to complete
  await tauriBaseUrlReady;
  // Re-run after the wait: iOS may have injected `__TAURI_INTERNALS__` by now.
  await initMobileConnection();

  const url = new URL(request.url);

  // Thin-client phone: stay on /connect until a Hub is chosen. Falling through
  // to registration/user-context sends the app to /login against a missing
  // local API — that is the flash-then-blank screen on ios:dev.
  if (needsRemoteHubConnect()) {
    if (!isCloudConnectPath(url.pathname)) {
      return redirect('/connect');
    }
    return null;
  }

  // Phone with a chosen remote Hub: do not wait on this appliance's
  // registration API. Those calls hang when the tunnel is slow or native
  // fetch is not yet routed, and `/` then shows the bootstrap spinner forever.
  if (isMobileClient() && getHubBaseUrlSync()) {
    if (url.pathname === '/') {
      return redirect('/login');
    }
    if (AUTH_BOOTSTRAP_PATHS.has(url.pathname)) {
      return null;
    }
    try {
      const userResult = await Promise.race([
        userContext(),
        new Promise<null>((resolve) => {
          globalThis.setTimeout(() => resolve(null), 8_000);
        }),
      ]);
      if (userResult?.data?.isLoggedIn) {
        return userResult;
      }
    } catch {
      /* show Hub login — the session check can retry there */
    }
    return redirect('/login');
  }

  const registration = await loadRegistrationLookup();

  if (registration.kind === 'unavailable') {
    if (url.pathname === '/device-registration' || url.pathname === '/login') {
      // Stay on the current bootstrap route while the API wakes up. Redirecting `/`
      // to device-registration here caused a flash loop with the registration page,
      // which navigates away as soon as status becomes operational again.
      return null;
    }
    if (url.pathname === '/') {
      return redirect('/login');
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
    userResult = await firstOf(userContext(), null, HUB_BOOTSTRAP_FETCH_MS);
    if (!userResult) {
      throw new Error('hub-bootstrap-timeout');
    }
    if (userResult.data?.isLoggedIn) {
      staleServerSessionCleared = false;
      setServerSessionRefreshRecommendedAt(userResult.data.sessionRefreshRecommendedAt ?? null);
      await refreshHubSessionIfDue();
    } else {
      if (!staleServerSessionCleared) {
        staleServerSessionCleared = true;
        await clearStaleServerSession();
      }
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
    return redirect('/register');
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

// Run on first client hydration. Without this, SSR can skip the mobile
// /connect redirect and leave ios:dev on a blank local-API spinner.
clientLoader.hydrate = true;

export function HydrateFallback() {
  return <DesktopStartupFallback />;
}

export function Layout({ children }: { children: React.ReactNode }) {
  useUpdateChecker();
  // The document is PRERENDERED with this false, so the emitted <body> holds a
  // bare startup gate. Initialising it from `typeof document` made the first
  // client render disagree with that HTML (#418) on every browser load; React
  // recovers by regenerating the tree, but behind the Cloudflare tunnel that
  // recovery strands the prerendered gate as a dead full-screen overlay. Stay
  // identical to the prerender for the first render, then flip in an effect.
  const [apiReady, setApiReady] = useState(false);
  const [documentTitle, setDocumentTitle] = useState(() => (i18next.isInitialized ? i18next.t('APP_NAME') : 'CI Hub'));
  const [documentLang, setDocumentLang] = useState(() => i18next.resolvedLanguage || i18next.language || 'en');
  // The document is PRERENDERED in Node, where isMobileClient() is false, so the
  // emitted <html>/<body> carry no mobile classes. Rendering them on the very
  // first client pass makes the markup disagree with that document and React
  // throws a hydration error (#418, args[]=HTML) — uncaught, which on Android
  // left the app a blank webview. Stay identical to the prerender for the first
  // render, then adopt the mobile classes once hydration has committed.
  const [mobileUi, setMobileUi] = useState(false);
  useEffect(() => {
    if (isMobileClient()) setMobileUi(true);
  }, []);

  useEffect(() => {
    installMobileLoadWatchdog();
    document.getElementById('ci-hub-boot')?.remove();
    document.getElementById('ci-hub-mobile-hud')?.remove();
    removeOrphanedStartupGates();
  }, []);

  useEffect(() => {
    // Browser and release desktop talk to a same-origin API that is already up;
    // a phone owns its own connect screen. Only the cross-origin desktop shell
    // has to wait for the port probe.
    if (isMobileClient() || !waitForMobileOrCrossOrigin) {
      setApiReady(true);
      return;
    }

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
    <html lang={documentLang} className={mobileUi ? 'ci-mobile' : undefined}>
      <head>
        <title>{documentTitle}</title>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body className={mobileUi ? 'bg-background text-foreground' : undefined}>
        <ThemeProvider defaultTheme={isMobileClient() ? 'light' : 'dark'}>
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
  // Do not poll on an unconnected phone — that loop is what blanks the connect UI.
  useEffect(() => {
    if (!onRootBootstrap || needsRemoteHubConnect()) return;

    void revalidate();
    const id = window.setInterval(() => {
      void revalidate();
    }, 1500);
    return () => window.clearInterval(id);
  }, [onRootBootstrap, revalidate]);

  // After a long idle the browser often keeps a half-open socket. Revalidate so
  // we abandon the hung bootstrap fetch instead of sitting on the connecting copy.
  useEffect(() => {
    return subscribeHubResume(() => {
      void revalidate();
    });
  }, [revalidate]);

  if (onRootBootstrap) {
    if (typeof document !== 'undefined' && usesCloudConnect()) {
      return <Navigate to={needsRemoteHubConnect() ? '/connect' : '/login'} replace />;
    }
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
