import { Navigate } from 'react-router';

// /store/hermes was never an app. The supported app is ci-hermes.
export default function LegacyHermesRedirect() {
  return <Navigate to="/store/ci-hermes" replace />;
}
