import { useEffect } from 'react';
import { Toaster } from 'react-hot-toast';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, redirect } from 'react-router';
import type { Route } from './+types/root';
import { userContext } from './api-client';
import { client } from './api-client/client.gen';
import stylesheet from './app.css?url';
import globalsStylesheet from './styles/globals.css?url';
import { Providers } from './components/providers/providers';
import { TranslatableError } from './types/error.types';

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

client.setConfig({
  credentials: 'include',
});

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

export async function clientLoader({ request }: Route.ActionArgs) {
  const url = new URL(request.url);

  // Check cached registration status (only 'true' is cached)
  const cachedRegistered = sessionStorage.getItem('device-registered') === 'true';

  // Fire both requests in parallel for speed
  const [regResult, userResult] = await Promise.all([
    cachedRegistered
      ? Promise.resolve({ ok: true, registered: true })
      : fetch('/api/registration/status')
          .then(async (res) => {
            if (!res.ok) return { ok: false, registered: false };
            const data = await res.json();
            // Cache only the registered=true state
            if (data.registered) {
              sessionStorage.setItem('device-registered', 'true');
            }
            return { ok: true, registered: data.registered };
          })
          .catch(() => ({ ok: false, registered: false })),
    userContext(),
  ]);

  // Registration redirect logic
  if (regResult.ok && !regResult.registered) {
    const allowedPaths = ['/device-registration', '/register', '/login', '/reset-password'];
    if (!allowedPaths.some((p) => url.pathname.startsWith(p))) {
      if (url.pathname === '/') {
        if (!userResult.data || !userResult.data.isConfigured) {
          return redirect('/register');
        }
      }
      return redirect('/device-registration');
    }
    return null;
  }

  if (regResult.ok && regResult.registered && url.pathname === '/device-registration') {
    return redirect('/');
  }

  if (url.pathname !== '/') {
    return userResult;
  }

  if (!userResult.data) {
    return redirect('/register');
  }

  if (!userResult.data.isConfigured) {
    return redirect('/register');
  }

  if (userResult.data?.isLoggedIn || userResult.data?.isGuestDashboardEnabled) {
    return redirect('/dashboard');
  }

  return redirect('/login');
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
        <main id="root">
          {children}
          <ScrollRestoration />
          <Scripts />
        </main>
      </body>
    </html>
  );
}

export default function App({ loaderData: _loaderData }: Route.ComponentProps) {
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
