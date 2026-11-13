import { Navigate } from 'react-router';

// The legacy /store/openclaw entry was the third-party umbrel wrapper. The supported app is ci-openclaw.
export default function LegacyOpenclawRedirect() {
  return <Navigate to="/store/ci-openclaw" replace />;
}
