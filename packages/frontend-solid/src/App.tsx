import { Router, Route, Navigate } from '@solidjs/router';
import { lazy } from 'solid-js';
import { ThemeProvider } from '@/components/providers/theme/theme-provider';
import { UserContextProvider } from '@/context/user-context';
import { AppContextProvider } from '@/context/app-context';
import { DashboardLayout } from '@/components/layouts/dashboard/layout';
import { useUserContext } from '@/context/user-context';
import { useAppContext } from '@/context/app-context';
import type { ParentComponent } from 'solid-js';
import { Show, Suspense } from 'solid-js';

// Lazy-loaded route pages
const LoginPage = lazy(() => import('@/routes/login'));
const RegisterPage = lazy(() => import('@/routes/register'));
const ResetPasswordPage = lazy(() => import('@/routes/reset-password'));
const DeviceRegistrationPage = lazy(() => import('@/routes/device-registration'));
const OnboardingPage = lazy(() => import('@/routes/onboarding'));
const DashboardPage = lazy(() => import('@/routes/dashboard'));
const AppStorePage = lazy(() => import('@/routes/app-store'));
const MyAppsPage = lazy(() => import('@/routes/my-apps'));
const SettingsPage = lazy(() => import('@/routes/settings'));
const NotFound = lazy(() => import('@/routes/not-found'));

/** Wraps authenticated routes — redirects to login if not logged in */
const AuthenticatedWrapper: ParentComponent = (props) => {
  const { userContext, isLoading: isUserLoading } = useUserContext();

  return (
    <Show when={!isUserLoading()} fallback={<LoadingSpinner />}>
      <Show when={userContext().isLoggedIn} fallback={<Navigate href="/login" />}>
        <AppContextProvider>
          <AuthenticatedContent>{props.children}</AuthenticatedContent>
        </AppContextProvider>
      </Show>
    </Show>
  );
};

const AuthenticatedContent: ParentComponent = (props) => {
  const { appContext, isLoading } = useAppContext();

  return (
    <Show when={!isLoading()} fallback={<LoadingSpinner />}>
      <Show when={appContext().user.hasCompletedOnboarding} fallback={<Navigate href="/onboarding" />}>
        <DashboardLayout isLoggedIn={true} isUpdateAvailable={false}>
          <Suspense fallback={<LoadingSpinner />}>{props.children}</Suspense>
        </DashboardLayout>
      </Show>
    </Show>
  );
};

function LoadingSpinner() {
  return (
    <div class="flex justify-center items-center p-5">
      <div class="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <UserContextProvider>
        <Router>
          {/* Unauthenticated routes */}
          <Route path="/login" component={LoginPage} />
          <Route path="/register" component={RegisterPage} />
          <Route path="/reset-password" component={ResetPasswordPage} />
          <Route path="/device-registration" component={DeviceRegistrationPage} />
          <Route path="/onboarding" component={OnboardingPage} />

          {/* Authenticated routes */}
          <Route
            path="/dashboard"
            component={() => (
              <AuthenticatedWrapper>
                <DashboardPage />
              </AuthenticatedWrapper>
            )}
          />
          <Route
            path="/app-store"
            component={() => (
              <AuthenticatedWrapper>
                <AppStorePage />
              </AuthenticatedWrapper>
            )}
          />
          <Route
            path={['/app-store/:storeId', '/app-store/:storeId/:appId', '/app-store/:storeId/:appId/update']}
            component={() => (
              <AuthenticatedWrapper>
                <AppStorePage />
              </AuthenticatedWrapper>
            )}
          />
          <Route
            path="/apps"
            component={() => (
              <AuthenticatedWrapper>
                <MyAppsPage />
              </AuthenticatedWrapper>
            )}
          />
          <Route
            path={['/apps/create', '/apps/:appId/edit', '/apps/:appId', '/apps/:storeId/:appId', '/apps/:storeId/:appId/update']}
            component={() => (
              <AuthenticatedWrapper>
                <MyAppsPage />
              </AuthenticatedWrapper>
            )}
          />
          <Route
            path="/settings"
            component={() => (
              <AuthenticatedWrapper>
                <SettingsPage />
              </AuthenticatedWrapper>
            )}
          />

          {/* Root redirect */}
          <Route path="/" component={() => <Navigate href="/dashboard" />} />

          {/* 404 */}
          <Route path="*" component={NotFound} />
        </Router>
      </UserContextProvider>
    </ThemeProvider>
  );
}
