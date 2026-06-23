import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { apiFetch } from '@/lib/api-fetch';
import { getStoredDriftChoice } from '@/lib/registration-state-drift';
import { GuestDashboard } from '@/modules/dashboard/pages/guest-dashboard';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Navigate, useLocation, useOutlet } from 'react-router';
import { ErrorPage } from '../error/error-page';
import { captureHubException } from '@/lib/sentry';
import { DashboardLayout, DashboardLayoutSuspense } from '../layouts/dashboard/layout';
import { SSEProvider } from '../providers/sse/sse-provider';
import { RouteWrapper } from './route-wrapper';

function AuthenticatedContent({ children }: { children: React.ReactNode }) {
  const { user, isLoading: isAppLoading } = useAppContext();
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
        const res = await apiFetch('/api/app-lifecycle/rehydrate/status');
        if (!res.ok) {
          if (!cancelled) {
            setShouldRestoreApps(false);
            setRestoreRedirectChecked(true);
          }
          return;
        }

        const status = (await res.json()) as { completed?: boolean; restoreIntent?: boolean };
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
        <div className="d-flex justify-content-center align-items-center p-5">
          <output className="spinner-border text-secondary" />
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
            <div className="d-flex justify-content-center align-items-center p-5">
              <output className="spinner-border text-secondary" />
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
  const { isLoggedIn, isGuestDashboardEnabled } = useUserContext();
  const outlet = useOutlet();

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
              captureHubException(error, { componentStack: info.componentStack ?? undefined });
            }}
          >
            <Suspense fallback={null}>
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
