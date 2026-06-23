import { userContext } from '@/api-client';
import { Navigate, redirect } from 'react-router';

export async function clientLoader() {
  const user = await userContext();

  if (user.data?.isLoggedIn) {
    return redirect('/home');
  }

  return redirect('/login');
}

export default () => {
  return <Navigate to="/login" replace />;
};
