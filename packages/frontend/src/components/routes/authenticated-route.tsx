import { MobileLoadError } from '@/components/mobile/mobile-load-error';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { isMobileClient } from '@/lib/mobile-connection';
import { useMobileLoadTimeout } from '@/lib/use-mobile-load-timeout';
import { getRehydrateStatus } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';
import { getStoredDriftChoice } from '@/lib/registration-state-drift';
import { opensRestorePage, restoreSeenInThisTab, setupRoute, type RestoreStatus } from '@/modules/auth/helpers/restore-status';
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
  const { user, isLoading: isAppLoading, loadFailed } = useAppContext();
  const { t } = useTranslation();
  const location = useLocation();
  const [restoreRedirectChecked, setRestoreRedirectChecked] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus | null>(null);

  // Asked on every sign-in, not only in the tab that chose "Restore existing device": the Hub restores
  // on its own after pairing. The person who signs in next may be anywhere (see opensRestorePage).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const statusResult = await sdkResult(getRehydrateStatus());
        if (!cancelled) {
          setRestoreStatus(statusResult.ok ? (statusResult.data ?? null) : null);
        }
      } catch {
        // No answer is not a restore: carry on to the requested page.
      } finally {
        if (!cancelled) {
          setRestoreRedirectChecked(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const shouldRestoreApps = opensRestorePage(restoreStatus, getStoredDriftChoice(), restoreSeenInThisTab());

  const appLoadTimedOut = useMobileLoadTimeout(isAppLoading || !restoreRedirectChecked);

  if (isMobileClient() && (appLoadTimedOut || loadFailed)) {
    return <MobileLoadError onRetry={() => window.location.reload()} />;
  }

  // Drift / restore check is cheap; keep a short gate so we don't flash the wrong route.
  if (!restoreRedirectChecked) {
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

  // Paint chrome (sidebar/header) while app-context is still loading. Do not
  // decide onboarding until we have a real payload — defaults say false.
  if (isAppLoading) {
    return (
      <SSEProvider>
        <DashboardLayout>
          <div className="flex items-center justify-center p-5">
            <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </DashboardLayout>
      </SSEProvider>
    );
  }

  // Redirect to onboarding if not completed. A failed load is not an answer:
  // keep the requested page (its own queries surface the outage) rather than
  // walking an onboarded operator into the wizard.
  if (!loadFailed && !user.hasCompletedOnboarding) {
    return <Navigate to={setupRoute(restoreStatus)} replace />;
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
  const sessionLoadTimedOut = useMobileLoadTimeout(isLoading);

  // Wait for the session query to settle before deciding where to send the user.
  // On a cold refresh the user-context query is still pending and reads its
  // unauthenticated DEFAULTS (isLoggedIn: false); acting on that bounces a
  // logged-in user to /login, whose loader then redirects to /home — silently
  // discarding a deep link like /apps/<store>/<app>. `isLoading` is only true on
  // the first uncached load, so cached navigations stay instant. Mirrors the
  // isAppLoading gate in AuthenticatedContent below.
  if (isMobileClient() && sessionLoadTimedOut) {
    return <MobileLoadError onRetry={() => window.location.reload()} />;
  }

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
