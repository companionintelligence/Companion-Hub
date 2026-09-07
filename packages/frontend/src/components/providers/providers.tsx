import { UserContextProvider } from '@/context/user-context';
import { QueryClient, QueryClientProvider, QueryErrorResetBoundary, useQueryClient } from '@tanstack/react-query';
import { type PropsWithChildren, Suspense, useEffect } from 'react';
import { subscribeHubResume } from '@/lib/hub-resume';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorPage } from '../error/error-page';
import { AutoThemeProvider } from './theme/auto-theme-provider';
import { HubSessionRefresh } from './hub-session-refresh';
import { DesktopPortalAuthListener } from './desktop-portal-auth-listener';
import { DesktopInstallIntentListener } from './desktop-install-intent-listener';
import { DebugPanel } from '../debug-panel/debug-panel';
import { openExternal } from '@/lib/helpers/open-external';
import { recoverFromChunkLoadError } from '@/lib/chunk-load-error';
import { captureHubException } from '@/lib/sentry';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const PageSuspense = ({ children }: PropsWithChildren) => {
  return (
    <div className="page">
      <div className="page-wrapper">{children}</div>
    </div>
  );
};

function HubResumeQueryRefresh() {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeHubResume(() => {
      void queryClient.invalidateQueries();
    });
  }, [queryClient]);

  return null;
}

export const Providers = ({ children }: PropsWithChildren) => {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    const handleClick = (e: MouseEvent) => {
      // Let the webview handle anything it already handles: a modified click is
      // the user asking for a new tab/window, and a non-primary button is not a
      // navigation at all.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;

      let target: URL;
      try {
        target = new URL(href, window.location.href);
      } catch {
        return;
      }
      // Only http(s) goes to the system browser. mailto:, tel: and the app's own
      // cihub:// links are left alone.
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return;

      // SAME-ORIGIN LINKS ARE NOT EXTERNAL, and this is the whole bug.
      //
      // The test used to be href.startsWith('http'), which is true of every
      // absolute URL — including the app's own. The packaged shell serves the Hub
      // UI from http://127.0.0.1:<apiPort>, and buildPortalSsoStartUrl always
      // produces an ABSOLUTE url against that same origin, so the "Continue with
      // CI Account" anchor was absolute, same-origin, and got shipped to the
      // system browser instead of navigating in-app. hub-auth-flow.ts states the
      // opposite contract for desktop-hub-sso: sign in via a normal <a href> and
      // never hand it to the browser.
      //
      // It only broke in a BUILT app: under `tauri dev` the page is the Vite dev
      // server, so the Hub API is cross-origin and this test happened to be right.
      if (target.origin === window.location.origin) return;

      e.preventDefault();
      void openExternal(target.href);
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary
            fallbackRender={({ error, resetErrorBoundary }) => (
              <PageSuspense>
                <ErrorPage error={error as Error} onReset={resetErrorBoundary} />
              </PageSuspense>
            )}
            onError={(error, info) => {
              if (recoverFromChunkLoadError(error)) {
                return;
              }
              console.error('Global React error boundary caught error:', error, info);
              captureHubException(error, { componentStack: info.componentStack ?? undefined });
            }}
            onReset={reset}
          >
            <Suspense fallback={<PageSuspense />}>
              <UserContextProvider>
                <HubResumeQueryRefresh />
                <DesktopPortalAuthListener />
                <DesktopInstallIntentListener />
                <HubSessionRefresh />
                <AutoThemeProvider>{children}</AutoThemeProvider>
              </UserContextProvider>
            </Suspense>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
      <DebugPanel />
    </QueryClientProvider>
  );
};
