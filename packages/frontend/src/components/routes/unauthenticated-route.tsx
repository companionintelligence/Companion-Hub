import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router';
import { AuthLayout } from '../layouts/auth/layout';
import { RouteWrapper } from './route-wrapper';

export default () => {
  const { pathname } = useLocation();
  const isDeviceRegistration = pathname === '/device-registration';

  return (
    <RouteWrapper>
      <Suspense fallback={<AuthLayout wide={isDeviceRegistration} />}>
        <AuthLayout wide={isDeviceRegistration}>
          <Outlet />
        </AuthLayout>
      </Suspense>
    </RouteWrapper>
  );
};
