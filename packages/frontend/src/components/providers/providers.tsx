import { UserContextProvider } from '@/context/user-context';
import { MutationCache, QueryClient, QueryClientProvider, QueryErrorResetBoundary } from '@tanstack/react-query';
import { type PropsWithChildren, Suspense, useEffect } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorPage } from '../error/error-page';
import { I18nProvider } from './i18n/i18n-provider';
import { AutoThemeProvider } from './theme/auto-theme-provider';
import { ThemeProvider } from './theme/theme-provider';
import { DebugPanel } from '../debug-panel/debug-panel';
import { openExternal } from '@/lib/helpers/open-external';

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  }),
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
              console.error('Global React error boundary caught error:', error, info);
            }}
            onReset={reset}
          >
            <Suspense fallback={<PageSuspense />}>
              <UserContextProvider>
                <ThemeProvider defaultTheme="dark">
                  <AutoThemeProvider>
                    <I18nProvider>{children}</I18nProvider>
                  </AutoThemeProvider>
                </ThemeProvider>
              </UserContextProvider>
            </Suspense>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
      <DebugPanel />
    </QueryClientProvider>
  );
};
