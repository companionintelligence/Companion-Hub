import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';

export default [
  // Mobile-only: choose a remote Hub before the rest of the app loads.
  // Inert on web/desktop (its loader redirects away when not on a phone).
  route('connect', './modules/mobile-connect/pages/connect-page.tsx', { id: 'mobile-connect' }),
  route('connect/advanced', './modules/mobile-connect/pages/connect-advanced-page.tsx', { id: 'mobile-connect-advanced' }),
  // Unauthenticated routes
  layout('./components/routes/unauthenticated-route.tsx', [
    route('login', './modules/auth/pages/login-page.tsx', { id: 'login' }),
    route('register', './modules/auth/pages/register-page.tsx', { id: 'register' }),
    route('reset-password', './modules/auth/pages/reset-password-page.tsx', { id: 'reset-password' }),
    route('device-registration', './modules/auth/pages/device-registration-page.tsx', { id: 'device-registration' }),
  ]),
  // Onboarding (authenticated but outside dashboard layout)
  route('onboarding', './modules/onboarding/pages/onboarding-page.tsx', { id: 'onboarding' }),
  route('restore-apps', './modules/auth/pages/restore-apps-page.tsx', { id: 'restore-apps' }),
  // Memory-connect finishing interstitial: the connect callback lands here while
  // the app restarts to pick up its new creds (full-page, self-gated).
  route('memory-connect/finishing', './modules/app/pages/memory-connect-finishing-page.tsx', { id: 'memory-connect-finishing' }),
  // Where a connect started in the phone app ends, in the browser it handed the consent to:
  // a "Back to the Hub app" button (full-page, self-gated like the finishing page).
  route('memory-connect/return-to-app', './modules/app/pages/memory-connect-return-page.tsx', { id: 'memory-connect-return' }),
  // Authenticated routes
  layout('./components/routes/authenticated-route.tsx', [
    route('home', './modules/dashboard/pages/dashboard.tsx', { id: 'dashboard' }),

    // App store routes
    ...prefix('store', [
      layout('./modules/app/layouts/app-store-layout.tsx', [
        index('./modules/app/pages/app-store-page.tsx', { id: 'app-store' }),
        route(':storeId', './modules/app/pages/app-store-page.tsx', { id: 'app-store-id' }),
        route(':storeId/:appId', './modules/app/pages/app-details-page.tsx', { id: 'app-details-store' }),
        route(':storeId/:appId/update', './modules/app/pages/app-update-page.tsx', { id: 'app-store-app-update' }),
      ]),
    ]),

    // My apps routes — /apps index redirects to app-store; sub-routes
    // remain for installed-app detail pages, custom apps, and updates.
    ...prefix('apps', [
      index('./modules/app/pages/apps-redirect.tsx', { id: 'my-apps' }),
      route('create', './modules/app/pages/custom-app-create-page.tsx', { id: 'custom-app-create' }),
      route('expose', './modules/app/pages/port-expose-create-page.tsx', { id: 'port-expose-create' }),
      route(':appId/edit', './modules/app/pages/custom-app-edit-page.tsx', { id: 'custom-app-edit' }),
      route(':appId', './modules/app/pages/custom-app-details-page.tsx', { id: 'custom-app' }),
      route(':storeId/:appId', './modules/app/pages/app-details-page.tsx', { id: 'app-details' }),
      route(':storeId/:appId/update', './modules/app/pages/app-update-page.tsx', { id: 'app-update' }),
    ]),

    // Settings route
    ...prefix('settings', [index('./modules/settings/pages/settings-page.tsx', { id: 'settings' })]),
    route('resource-monitor', './modules/system/pages/resource-monitor-page.tsx', { id: 'resource-monitor' }),
    // Inside the signed-in layout so a page that doesn't exist keeps the Hub's header and navigation.
    // A visitor who isn't signed in gets what the layout gives them: sign-in, or the guest dashboard.
    route('*', './routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
