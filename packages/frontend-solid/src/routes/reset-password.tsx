import { createSignal, createResource, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '@/api-client';
import { useUserContext } from '@/context/user-context';
import { Input, Alert, Card, CardContent, LoadingSpinner } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { toast } from '@/stores/toast-store';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { userContext } = useUserContext();
  const [password, setPassword] = createSignal('');
  const [passwordConfirm, setPasswordConfirm] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [resetSuccess, setResetSuccess] = createSignal<{ email: string } | null>(null);

  const [checkData] = createResource(() => api.checkResetPasswordRequest());

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (password() !== passwordConfirm()) {
      toast.error('Passwords do not match');
      return;
    }
    if (password().length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      const result = await api.resetPassword({ newPassword: password() });
      if (result.success) setResetSuccess({ email: result.email });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    setLoading(true);
    try {
      await api.cancelResetPassword();
      navigate('/login');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="flex flex-col items-center justify-center min-h-screen">
      <div class="rounded-xl border bg-card text-card-foreground shadow p-8 w-full max-w-md">
        <Show when={!checkData.loading} fallback={<LoadingSpinner />}>
          <Show when={resetSuccess()} fallback={
            <Show when={checkData()?.isRequestPending} fallback={
              <Show when={userContext().isPasswordResetDisabled} fallback={
                <>
                  <h2 class="text-xl font-semibold text-center mb-4">Reset Password</h2>
                  <p class="text-sm text-muted-foreground mb-4">To reset your password, run the following command on your server:</p>
                  <pre class="bg-muted/50 rounded-lg p-3 text-sm"><code>./ci-hub-cli reset-password</code></pre>
                </>
              }>
                <div class="text-center">
                  <h2 class="text-xl font-semibold text-center mb-3">Demo Account Credentials</h2>
                  <p class="text-sm text-muted-foreground mb-4">For demo purposes, use the following credentials:</p>
                  <Card class="bg-muted/50 mb-4">
                    <CardContent class="p-4">
                      <div class="flex flex-col gap-3">
                        <div class="flex items-center justify-between">
                          <span class="text-sm text-muted-foreground font-medium">Email:</span>
                          <code class="text-sm font-semibold text-primary">me@{userContext().domain}</code>
                        </div>
                        <div class="flex items-center justify-between">
                          <span class="text-sm text-muted-foreground font-medium">Password:</span>
                          <code class="text-sm font-semibold text-primary">{userContext().domain}</code>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Button class="w-full" onClick={() => navigate('/login')}>Back to Login</Button>
                </div>
              </Show>
            }>
              <h2 class="text-xl font-semibold text-center mb-4">Reset Password</h2>
              <form onSubmit={handleSubmit}>
                <Input label="New Password" type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} disabled={loading()} placeholder="New password" class="mb-3" />
                <Input label="Confirm Password" type="password" value={passwordConfirm()} onInput={(e) => setPasswordConfirm(e.currentTarget.value)} disabled={loading()} placeholder="Confirm password" class="mb-3" />
                <div class="mt-4">
                  <Button type="submit" class="w-full mb-3" disabled={loading()}>
                    {loading() ? 'Resetting...' : 'Reset Password'}
                  </Button>
                  <Button variant="outline" class="w-full" onClick={handleCancel} disabled={loading()}>Cancel</Button>
                </div>
              </form>
            </Show>
          }>
            {(success) => (
              <>
                <h2 class="text-xl font-semibold text-center mb-4">Password Reset Successfully</h2>
                <p class="text-sm text-muted-foreground mb-4">
                  Password has been reset for <code>{success().email}</code>.
                </p>
                <Button class="w-full" onClick={() => navigate('/login')}>Back to Login</Button>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
