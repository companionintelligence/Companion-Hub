import { Titlebar } from './components/titlebar/titlebar';
import { HubStatus } from './components/hub-status/hub-status';
import { useEffect, useRef } from 'react';
import { Toaster } from 'react-hot-toast';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, redirect, useLocation, useRevalidator } from 'react-router';
import type { Route } from './+types/root';
import { userContext } from './api-client';
import { client } from './api-client/client.gen';
import stylesheet from './app.css?url';
import globalsStylesheet from './styles/globals.css?url';
import { Providers } from './components/providers/providers';
import { TranslatableError } from './types/error.types';
import { apiFetch, getTauriSessionId } from './lib/api-fetch';
import type { RegistrationStatus } from './lib/registration-status';
import { isRegistrationOperational, requiresDeviceRegistration } from './lib/registration-status';

// Add session header for Tauri release mode (cookies don't work cross-origin over HTTP)
client.interceptors.request.use((request) => {
  const sid = getTauriSessionId();
  if (sid) {
    request.headers.set('X-CI-Hub-Session', sid);
  }
  return request;
});

client.interceptors.response.use(async (res) => {
  if (res.status >= 400) {
    let data: { message?: string; intlParams?: Record<string, string> } = {};

    // Try to parse JSON, but handle empty or invalid responses gracefully
    try {
      const text = await res.text();
      if (text) {
        data = JSON.parse(text);
      }
    } catch (_e) {
      // If JSON parsing fails, use a default error message
      data = { message: res.statusText || 'An error occurred' };
    }

    const error = new TranslatableError(data.message || `HTTP ${res.status}: ${res.statusText}`);
    error.intlParams = data.intlParams ?? {};

    throw error;
  }

  return res;
});

// In Tauri release mode, the frontend is served from tauri://localhost
// but the API is on a local HTTP port. Detect Tauri and set the baseUrl.
// Cross-origin credentials ('include') are blocked by browsers when the server
// responds with Access-Control-Allow-Origin: * — so we use 'omit' in Tauri mode.
const isTauriRelease = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !window.location.origin.startsWith('http://localhost');
const credentialMode: RequestCredentials = isTauriRelease ? 'omit' : 'include';

client.setConfig({
  credentials: credentialMode,
});

// Probe the backend port — try 5002 (prod) then 3000 (dev)
const tauriBaseUrlReady: Promise<void> = isTauriRelease
  ? (async () => {
      for (const port of [5002, 3000]) {
        try {
          const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            client.setConfig({ baseUrl: `http://localhost:${port}`, credentials: credentialMode });
            return;
          }
        } catch {
          /* try next */
        }
      }
      // Neither responded — default to 5002, HubStatus will show the "not running" overlay
      client.setConfig({ baseUrl: 'http://localhost:5002', credentials: credentialMode });
    })()
  : Promise.resolve();

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@200;400;500;600;700&display=swap' },
  { rel: 'stylesheet', href: stylesheet },
  { rel: 'stylesheet', href: globalsStylesheet },
  { rel: 'icon', type: 'image/x-icon', href: '/icons/favicon.ico' },
  { rel: 'shortcut icon', href: '/icons/favicon.ico' },
  { rel: 'manifest', href: '/icons/site.webmanifest' },
];

type RegistrationLookup = { kind: 'ok'; status: RegistrationStatus } | { kind: 'unavailable' };

const CACHED_OPERATIONAL_STATUS: RegistrationStatus = {
  phase: 'locally_ready',
  degradedReasons: [],
  registered: true,
};

async function loadRegistrationLookup(): Promise<RegistrationLookup> {
  const CACHE_TTL_MS = 60 * 1000;
  const cachedAt = Number(sessionStorage.getItem('device-registered-at') || '0');
  const cacheValid = sessionStorage.getItem('device-registered') === 'true' && Date.now() - cachedAt < CACHE_TTL_MS;

  if (cacheValid) {
    return { kind: 'ok', status: CACHED_OPERATIONAL_STATUS };
  }

  try {
    const res = await apiFetch('/api/registration/status');
    if (!res.ok) {
      return { kind: 'unavailable' };
    }

    const status = (await res.json()) as RegistrationStatus;

    if (isRegistrationOperational(status)) {
      sessionStorage.setItem('device-registered', 'true');
      sessionStorage.setItem('device-registered-at', String(Date.now()));
    } else {
      sessionStorage.removeItem('device-registered');
      sessionStorage.removeItem('device-registered-at');
    }

    return { kind: 'ok', status };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function clientLoader({ request }: Route.ActionArgs) {
  // In Tauri release mode, wait for the backend port probe to complete
  await tauriBaseUrlReady;

  const url = new URL(request.url);
  const registration = await loadRegistrationLookup();

  if (registration.kind === 'ok' && requiresDeviceRegistration(registration.status)) {
    if (url.pathname !== '/device-registration') {
      return redirect('/device-registration');
    }
    return null;
  }

  if (registration.kind === 'unavailable' && url.pathname === '/device-registration') {
    return null;
  }

  if (registration.kind === 'ok' && isRegistrationOperational(registration.status) && url.pathname === '/device-registration') {
    return redirect('/');
  }

  // Now check user context for auth/onboarding flow.
  // In desktop startup races the API may be temporarily unavailable even when
  // containers are still booting; avoid throwing into the route ErrorBoundary.
  let userResult: Awaited<ReturnType<typeof userContext>> | null = null;
  try {
    userResult = await userContext();
  } catch {
    return null;
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

  return redirect('/dashboard');
}

export function Layout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const handlePreloadError = () => {
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
            el.innerHTML =
              '<div style="display:flex; gap:8px; align-items:center;"><span>Dev: UI modules not loaded</span><button id="ci-hub-dev-reload" style="background:#fff;color:#000;border:none;padding:6px 8px;border-radius:6px;cursor:pointer">Reload</button></div>';
            document.body.appendChild(el);
            const btn = document.getElementById('ci-hub-dev-reload');
            btn?.addEventListener('click', () => location.reload());
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
    <html lang="en">
      <head>
        <title>Companion Hub</title>
        <meta charSet="UTF-8" />
        <script src="/js/tabler.min.js" async />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <Meta />
        <Links />
      </head>
      <body>
        <Titlebar />
        <HubStatus>
          <main id="root">
            {children}
            <ScrollRestoration />
          </main>
        </HubStatus>
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  const { revalidate } = useRevalidator();
  const location = useLocation();
  const hasRevalidatedRef = useRef(false);

  // When the root clientLoader runs during startup before the backend is
  // ready, it returns null (no redirect). HubStatus hides children until
  // the hub is Running, so by the time this component mounts the backend
  // is available. Trigger a one-shot revalidation to re-run the loader
  // and perform the correct redirect.
  useEffect(() => {
    if (location.pathname === '/' && loaderData == null && !hasRevalidatedRef.current) {
      hasRevalidatedRef.current = true;
      revalidate();
    }
  }, [location.pathname, loaderData, revalidate]);

  return (
    <Providers>
      <Outlet />
      <Toaster />
    </Providers>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (import.meta.env.DEV) {
    console.error('Route ErrorBoundary captured error:', error);
  }

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details = error.status === 404 ? 'The requested page could not be found.' : error.statusText || details;
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
