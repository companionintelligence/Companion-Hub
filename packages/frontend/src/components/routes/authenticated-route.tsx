import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { getRehydrateStatus } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';
import { getStoredDriftChoice } from '@/lib/registration-state-drift';
import { GuestDashboard } from '@/modules/dashboard/pages/guest-dashboard';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useOutlet } from 'react-router';
import { ErrorPage } from '../error/error-page';
import { recoverFromChunkLoadError } from '@/lib/chunk-load-error';
import { captureHubException } from '@/lib/sentry';
import { DashboardLayout, DashboardLayoutSuspense } from '../layouts/dashboard/layout';
import { SSEProvider } from '../providers/sse/sse-provider';
import { RouteWrapper } from './route-wrapper';

function AuthenticatedContent({ children }: { children: React.ReactNode }) {
  const { user, isLoading: isAppLoading } = useAppContext();
  const { t } = useTranslation();
  const location = useLocation();
  const [restoreRedirectChecked, setRestoreRedirectChecked] = useState(false);
  const [shouldRestoreApps, setShouldRestoreApps] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const driftChoice = getStoredDriftChoice();
      if (driftChoice !== 'restore') {
        if (!cancelled) {
          setShouldRestoreApps(false);
          setRestoreRedirectChecked(true);
        }
        return;
      }

      try {
        const statusResult = await sdkResult(getRehydrateStatus());
        if (!statusResult.ok) {
          if (!cancelled) {
            setShouldRestoreApps(false);
            setRestoreRedirectChecked(true);
          }
          return;
        }

        const status = statusResult.data as { completed?: boolean; restoreIntent?: boolean };
        const pendingRestore = !status.completed && (driftChoice === 'restore' || Boolean(status.restoreIntent));
        if (!cancelled) {
          setShouldRestoreApps(pendingRestore);
          setRestoreRedirectChecked(true);
        }
      } catch {
        if (!cancelled) {
          setShouldRestoreApps(false);
          setRestoreRedirectChecked(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Wait for app context to load before checking onboarding
  if (isAppLoading || !restoreRedirectChecked) {
    return (
      <DashboardLayoutSuspense>
        <div className="flex items-center justify-center p-5">
          <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayoutSuspense>
    );
  }

  if (shouldRestoreApps && location.pathname !== '/restore-apps') {
    return <Navigate to="/restore-apps" replace />;
  }

  // Redirect to onboarding if not completed
  if (!user.hasCompletedOnboarding) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <SSEProvider>
      <DashboardLayout>
        <Suspense
          fallback={
            <div className="flex items-center justify-center p-5">
              <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
        >
          {children}
        </Suspense>
      </DashboardLayout>
    </SSEProvider>
  );
}

export default () => {
  const { isLoggedIn, isGuestDashboardEnabled, isLoading } = useUserContext();
  const { t } = useTranslation();
  const outlet = useOutlet();

  // Wait for the session query to settle before deciding where to send the user.
  // On a cold refresh the user-context query is still pending and reads its
  // unauthenticated DEFAULTS (isLoggedIn: false); acting on that bounces a
  // logged-in user to /login, whose loader then redirects to /home — silently
  // discarding a deep link like /apps/<store>/<app>. `isLoading` is only true on
  // the first uncached load, so cached navigations stay instant. Mirrors the
  // isAppLoading gate in AuthenticatedContent below.
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-5">
        <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isLoggedIn && !isGuestDashboardEnabled) {
    return <Navigate to="/login" replace />;
  }

  if (isGuestDashboardEnabled && !isLoggedIn) {
    return <GuestDashboard />;
  }

  return (
    <RouteWrapper>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary
            fallbackRender={({ error, resetErrorBoundary }) => (
              <DashboardLayoutSuspense>
                <ErrorPage error={error as Error} onReset={resetErrorBoundary} />
              </DashboardLayoutSuspense>
            )}
            onReset={reset}
            onError={(error, info) => {
              if (recoverFromChunkLoadError(error)) {
                return;
              }
              captureHubException(error, { componentStack: info.componentStack ?? undefined });
            }}
          >
            <Suspense
              fallback={
                <div className="flex min-h-[40vh] items-center justify-center p-5">
                  <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <AppContextProvider>
                <AuthenticatedContent>{outlet}</AuthenticatedContent>
              </AppContextProvider>
            </Suspense>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </RouteWrapper>
  );
};
