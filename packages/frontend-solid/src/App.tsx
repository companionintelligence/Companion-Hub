import { Router, Route, Navigate } from '@solidjs/router';
import { lazy } from 'solid-js';
import { ThemeProvider } from '@/components/providers/theme/theme-provider';
import { SSEProvider } from '@/components/providers/sse/sse-provider';
import { ToastContainer } from '@/components/providers/toast/toast-container';
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
const AppDetailsPage = lazy(() => import('@/routes/app-details'));
const MyAppsPage = lazy(() => import('@/routes/my-apps'));
const CustomAppCreatePage = lazy(() => import('@/routes/custom-app-create'));
const SettingsPage = lazy(() => import('@/routes/settings'));
const NotFound = lazy(() => import('@/routes/not-found'));

/** Wraps authenticated routes — redirects to login if not logged in */
const AuthenticatedWrapper: ParentComponent = (props) => {
  const { userContext, isLoading: isUserLoading } = useUserContext();

  return (
    <Show when={!isUserLoading()} fallback={<LoadingSpinner />}>
      <Show when={userContext().isLoggedIn} fallback={<Navigate href="/login" />}>
        <AppContextProvider>
          <SSEProvider>
            <AuthenticatedContent>{props.children}</AuthenticatedContent>
          </SSEProvider>
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

function AuthRoute(props: { children: import('solid-js').JSX.Element }) {
  return <AuthenticatedWrapper>{props.children}</AuthenticatedWrapper>;
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
          <Route path="/dashboard" component={() => <AuthRoute><DashboardPage /></AuthRoute>} />

          <Route path="/app-store" component={() => <AuthRoute><AppStorePage /></AuthRoute>} />
          <Route path="/app-store/:storeId" component={() => <AuthRoute><AppStorePage /></AuthRoute>} />
          <Route path="/app-store/:storeId/:appId" component={() => <AuthRoute><AppDetailsPage /></AuthRoute>} />
          <Route path="/app-store/:storeId/:appId/update" component={() => <AuthRoute><AppDetailsPage /></AuthRoute>} />

          <Route path="/apps" component={() => <AuthRoute><MyAppsPage /></AuthRoute>} />
          <Route path="/apps/create" component={() => <AuthRoute><CustomAppCreatePage /></AuthRoute>} />
          <Route path="/apps/:appId/edit" component={() => <AuthRoute><CustomAppCreatePage /></AuthRoute>} />
          <Route path="/apps/:storeId/:appId" component={() => <AuthRoute><AppDetailsPage /></AuthRoute>} />
          <Route path="/apps/:storeId/:appId/update" component={() => <AuthRoute><AppDetailsPage /></AuthRoute>} />

          <Route path="/settings" component={() => <AuthRoute><SettingsPage /></AuthRoute>} />

          {/* Root redirect */}
          <Route path="/" component={() => <Navigate href="/dashboard" />} />

          {/* 404 */}
          <Route path="*" component={NotFound} />
        </Router>
        <ToastContainer />
      </UserContextProvider>
    </ThemeProvider>
  );
}
