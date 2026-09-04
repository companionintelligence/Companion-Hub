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
      const anchor = (e.target as Element).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href?.startsWith('http')) return;
      e.preventDefault();
      openExternal(href);
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
