import { createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '@/api-client';
import { useUserContext } from '@/context/user-context';
import { Input } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { toast } from '@/stores/toast-store';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { userContext, refetch } = useUserContext();
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [passwordConfirm, setPasswordConfirm] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [errors, setErrors] = createSignal<Record<string, string>>({});

  if (userContext().isLoggedIn) {
    navigate('/dashboard');
    return null;
  }
  if (userContext().isConfigured) {
    navigate('/login');
    return null;
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (password().length < 8) errs.password = 'Password must be at least 8 characters';
    if (password() !== passwordConfirm()) errs.passwordConfirm = 'Passwords do not match';
    if (!email()) errs.email = 'Email is required';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setLoading(true);
    try {
      await api.register({ username: email(), password: password() });
      refetch();
      navigate('/onboarding');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="flex flex-col items-center justify-center min-h-screen">
      <div class="rounded-xl border bg-card text-card-foreground shadow p-8 w-full max-w-md">
        <h2 class="text-xl font-semibold text-center mb-4">Create your account</h2>
        <form onSubmit={handleSubmit}>
          <Input label="Email" type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} disabled={loading()} error={errors().email} placeholder="you@example.com" class="mb-3" />
          <Input label="Password" type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} disabled={loading()} error={errors().password} placeholder="••••••••" class="mb-3" />
          <Input label="Confirm Password" type="password" value={passwordConfirm()} onInput={(e) => setPasswordConfirm(e.currentTarget.value)} disabled={loading()} error={errors().passwordConfirm} placeholder="••••••••" class="mb-3" />
          <div class="mt-4">
            <Button type="submit" class="w-full" disabled={loading()}>
              {loading() ? 'Creating account...' : 'Register'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
