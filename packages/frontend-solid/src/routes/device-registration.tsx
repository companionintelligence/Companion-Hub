import { createSignal, createEffect, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { rawApiFetch, api } from '@/api-client';
import { Alert } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { toast } from '@/stores/toast-store';
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-solid';

const DEFAULT_PORTAL_URL = 'https://portal.companionintelligence.com';

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();
  const [deviceId, setDeviceId] = createSignal<string | null>(null);
  const [portalBaseUrl, setPortalBaseUrl] = createSignal(DEFAULT_PORTAL_URL);
  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [pairingCode, setPairingCode] = createSignal('');
  const [isPairing, setIsPairing] = createSignal(false);
  const [pairingError, setPairingError] = createSignal<string | null>(null);
  const [pairingSuccess, setPairingSuccess] = createSignal(false);
  const [redirectStatus, setRedirectStatus] = createSignal('Setting up your Hub...');

  let pairingInputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (!isLoading() && deviceId() && pairingInputRef) {
      pairingInputRef.focus();
    }
  });

  // Check status on mount
  (async () => {
    try {
      const status = await api.getRegistrationStatus();
      if (status.registered) { navigate('/'); return; }

      const deviceRes = await rawApiFetch('/registration/device-id');
      if (deviceRes.ok) {
        const data = await deviceRes.json();
        setDeviceId(data.device_id);
        const base = data.ci_cloud_url?.trim();
        if (base) setPortalBaseUrl(base.replace(/\/+$/, ''));
      } else {
        setError('Failed to get device information');
      }
    } catch {
      setError('Failed to check registration status');
    } finally {
      setIsLoading(false);
    }
  })();

  const handlePair = async () => {
    const code = pairingCode().trim().toUpperCase();
    if (code.length !== 6) {
      setPairingError('Pairing code must be exactly 6 characters.');
      return;
    }

    setIsPairing(true);
    setPairingError(null);
    setError(null);

    try {
      const data = await api.pairDevice({ pairing_code: code });
      if (data.success) {
        setPairingSuccess(true);
        toast.success('Device registered successfully!');

        const isTauri = '__TAURI_INTERNALS__' in window;
        if (isTauri) {
          setRedirectStatus('Registration complete! Loading...');
          sessionStorage.setItem('device-registered', 'true');
          await new Promise((r) => setTimeout(r, 2000));
          window.location.href = '/';
        } else if (data.domain && data.subdomain) {
          const fullUrl = `https://${data.subdomain}.${data.domain}`;
          setRedirectStatus('Setting up your Hub...');

          let attempts = 0;
          let tunnelReady = false;
          while (attempts < 60) {
            try {
              const probe = await api.probeDomain(fullUrl);
              if (probe.ready) { tunnelReady = true; break; }
            } catch { /* ignore */ }
            attempts++;
            if (attempts >= 12) setRedirectStatus('Waiting for DNS propagation...');
            if (attempts >= 36) setRedirectStatus('Still waiting — this can take a few minutes...');
            await new Promise((r) => setTimeout(r, 5000));
          }

          if (tunnelReady) {
            setRedirectStatus('Redirecting...');
            window.location.href = `${fullUrl}/login`;
          } else {
            setRedirectStatus('Tunnel setup is still in progress. Redirecting locally...');
            toast.info('Cloudflare tunnel is still propagating.');
            await new Promise((r) => setTimeout(r, 3000));
            navigate('/', { replace: true });
          }
        } else {
          setTimeout(() => navigate('/', { replace: true }), 2000);
        }
      } else {
        setPairingError('Registration failed.');
      }
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : 'Failed to register device.');
    } finally {
      setIsPairing(false);
    }
  };

  return (
    <div class="flex flex-col items-center justify-center min-h-screen">
      <div class="rounded-xl border bg-card text-card-foreground shadow p-8 w-full max-w-md">
        <Show when={!isLoading()} fallback={
          <div class="flex flex-col items-center gap-4 text-center py-4">
            <Loader2 class="h-8 w-8 animate-spin text-primary" />
            <h2 class="text-xl font-semibold">Checking registration status...</h2>
          </div>
        }>
          <Show when={!pairingSuccess()} fallback={
            <div class="flex flex-col items-center gap-4 text-center py-4">
              <CheckCircle2 class="h-12 w-12 text-green-500" />
              <h2 class="text-xl font-semibold">Device Registered Successfully</h2>
              <p class="text-sm text-muted-foreground mt-3">{redirectStatus()}</p>
              <Loader2 class="h-6 w-6 animate-spin text-primary" />
            </div>
          }>
            <h2 class="text-xl font-semibold text-center mb-4">Device Registration Required</h2>
            <p class="text-sm text-muted-foreground text-center mb-6">
              Enter the 6-character pairing code from{' '}
              <a href={portalBaseUrl()} target="_blank" rel="noopener noreferrer" class="text-primary underline hover:no-underline">CI Portal</a>
              {' '}to register this device.
            </p>

            <Show when={deviceId()}>
              <div class="mb-4 p-3 bg-muted/50 rounded-lg">
                <p class="text-xs text-muted-foreground mb-1">Device ID</p>
                <p class="font-mono text-sm break-all">{deviceId()}</p>
              </div>
            </Show>

            <Show when={error()}>
              <Alert variant="danger" class="mb-4">
                <div class="flex items-start gap-2">
                  <AlertCircle class="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>{error()}</span>
                </div>
              </Alert>
            </Show>

            <div class="mb-6 space-y-2">
              <label for="pairing-code" class="text-sm font-medium leading-none block">Pairing Code</label>
              <div class="flex gap-2">
                <input
                  id="pairing-code"
                  ref={pairingInputRef}
                  placeholder="ABC123"
                  value={pairingCode()}
                  onInput={(e) => {
                    const val = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                    setPairingCode(val);
                    setPairingError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && pairingCode().length === 6 && !isPairing()) handlePair();
                  }}
                  maxLength={6}
                  disabled={isPairing()}
                  class={`flex-1 h-9 rounded-md border bg-transparent px-3 py-1 text-base shadow-sm transition-colors font-mono tracking-widest placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ${pairingError() ? 'border-destructive focus-visible:ring-destructive' : 'border-input'}`}
                />
                <Button onClick={handlePair} disabled={pairingCode().length !== 6 || isPairing()}>
                  {isPairing() ? 'Registering...' : 'Register'}
                </Button>
              </div>
              <Show when={pairingError()}>
                <p class="text-[0.8rem] font-medium text-destructive">{pairingError()}</p>
              </Show>
            </div>

            <p class="text-xs text-muted-foreground text-center">
              Don't have a pairing code?{' '}
              <a href={portalBaseUrl()} target="_blank" rel="noopener noreferrer" class="text-primary underline hover:no-underline">Visit CI Portal</a>
              {' '}to create an account and add a device.
            </p>
          </Show>
        </Show>
      </div>
    </div>
  );
}
