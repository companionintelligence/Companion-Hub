import { createSignal, Show } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { api, setTauriSessionId } from '@/api-client';
import { useUserContext } from '@/context/user-context';
import { Input } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { OtpInput } from '@/components/ui/shared';
import { toast } from '@/stores/toast-store';

export default function LoginPage() {
  const navigate = useNavigate();
  const { userContext, refetch } = useUserContext();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [totpSessionId, setTotpSessionId] = createSignal<string | null>(null);
  const [totpCode, setTotpCode] = createSignal('');

  const redirectUrl = () => searchParams.redirect_url as string | undefined;

  const isSafeRedirect = (url: string) => {
    try { return new URL(url).host.endsWith(`.${window.location.host}`); }
    catch { return false; }
  };

  const handleRedirect = () => {
    const url = redirectUrl();
    if (url && isSafeRedirect(url)) {
      window.location.href = url;
      return;
    }
    navigate('/dashboard');
  };

  // Redirect if already logged in
  if (userContext().isLoggedIn) {
    handleRedirect();
    return null;
  }

  if (!userContext().isConfigured) {
    navigate('/register');
    return null;
  }

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await api.login({ username: email(), password: password() });
      if (result.totpSessionId) {
        setTotpSessionId(result.totpSessionId);
      } else {
        if (result.sessionId) setTauriSessionId(result.sessionId);
        refetch();
        handleRedirect();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTotp = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.verifyTotp({ totpCode: totpCode(), totpSessionId: totpSessionId()! });
      refetch();
      handleRedirect();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="flex flex-col items-center justify-center min-h-screen">
      <div class="rounded-xl border bg-card text-card-foreground shadow p-8 w-full max-w-md">
        <Show when={totpSessionId()} fallback={
          <>
            <h2 class="text-xl font-semibold text-center mb-4">Login</h2>
            <form onSubmit={handleLogin}>
              <Input
                label="Email"
                type="email"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                disabled={loading()}
                placeholder="you@example.com"
                class="mb-3"
              />
              <Input
                label="Password"
                type="password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                disabled={loading()}
                placeholder="••••••••"
                class="mb-3"
              />
              <div class="mt-4">
                <Button type="submit" class="w-full" disabled={!email() || !password() || loading()}>
                  {loading() ? 'Logging in...' : 'Login'}
                </Button>
              </div>
              <Show when={!userContext().isPasswordResetDisabled}>
                <div class="text-sm text-muted-foreground text-center mt-3">
                  <a href="/reset-password" class="hover:underline">Forgot password?</a>
                </div>
              </Show>
            </form>
          </>
        }>
          <h2 class="text-xl font-semibold text-center mb-4">Two-Factor Authentication</h2>
          <form onSubmit={handleTotp}>
            <p class="text-sm text-muted-foreground mb-3">Enter the 6-digit code from your authenticator app.</p>
            <OtpInput value={totpCode()} onChange={setTotpCode} valueLength={6} />
            <div class="mt-4">
              <Button type="submit" class="w-full" disabled={totpCode().length < 6 || loading()}>
                {loading() ? 'Verifying...' : 'Verify'}
              </Button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}
