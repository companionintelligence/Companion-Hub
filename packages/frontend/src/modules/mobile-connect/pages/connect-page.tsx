import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { getHubBaseUrlSync, initMobileConnection, isTauriMobileSync, setHubConnection } from '@/lib/mobile-connection';
import { type FormEvent, useState } from 'react';
import toast from 'react-hot-toast';
import { redirect, useNavigate } from 'react-router';
import { DEFAULT_PORTAL_URL, type HubDevice, listHubDevices, type PortalAuth, signInToPortal } from '../portal-client';

/**
 * Mobile-only entry screen. The user signs into the CI cloud, picks one of the
 * Hub appliances they own, and the app points the shared frontend at it. The
 * actual Hub login (portal SSO / password) is then handled by the existing
 * `/login` page against the chosen Hub.
 */
export async function clientLoader() {
  const { isMobile, hubBaseUrl } = await initMobileConnection();
  if (!isMobile) {
    // Web/desktop never see this screen.
    return redirect('/');
  }
  if (hubBaseUrl) {
    // A Hub is already chosen — let the normal routing take over.
    return redirect('/');
  }
  return null;
}

type Step = 'sign-in' | 'pick';

export default function ConnectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [portalUrl, setPortalUrl] = useState(DEFAULT_PORTAL_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [auth, setAuth] = useState<PortalAuth | null>(null);
  const [devices, setDevices] = useState<HubDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  // Render nothing meaningful off-mobile; the loader already redirects.
  if (!isTauriMobileSync() && getHubBaseUrlSync()) {
    return null;
  }

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    try {
      const portalAuth = await signInToPortal(email, password, portalUrl);
      setAuth(portalAuth);
      const list = await listHubDevices(portalAuth, portalUrl);
      setDevices(list);
      setStep('pick');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (!auth) return;
    setBusy(true);
    try {
      setDevices(await listHubDevices(auth, portalUrl));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh');
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (device: HubDevice) => {
    if (!device.hubUrl) {
      toast.error('This Hub has no reachable address yet.');
      return;
    }
    setConnectingId(device.id);
    try {
      await setHubConnection(device.hubUrl);
      // Hand off to the existing Hub login (portal SSO / password) for this Hub.
      navigate('/login');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not connect');
      setConnectingId(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{step === 'sign-in' ? 'Connect to your Hub' : 'Choose a Hub'}</CardTitle>
          <CardDescription>
            {step === 'sign-in'
              ? 'Sign in to Companion Intelligence to find the Hubs you own.'
              : 'Pick the Hub appliance you want to use on this device.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'sign-in' ? (
            <form onSubmit={handleSignIn} className="flex flex-col gap-4">
              <Input
                type="email"
                placeholder="you@example.com"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <PasswordInput
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {showAdvanced ? (
                <Input type="url" placeholder="Portal URL" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} />
              ) : (
                <button type="button" className="self-start text-xs text-muted-foreground underline" onClick={() => setShowAdvanced(true)}>
                  Advanced
                </button>
              )}
              <Button type="submit" loading={busy} disabled={busy || !email || !password}>
                Sign in
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              {devices.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No Hubs found on this account yet.</p>
              ) : (
                devices.map((device) => {
                  const reachable = Boolean(device.hubUrl) && device.status === 'active';
                  return (
                    <button
                      key={device.id}
                      type="button"
                      disabled={connectingId !== null}
                      onClick={() => handleConnect(device)}
                      className="flex items-center justify-between rounded-md border border-input p-3 text-left transition-colors hover:bg-accent disabled:opacity-60"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{device.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{device.hubUrl ?? 'No address'}</div>
                      </div>
                      {connectingId === device.id ? (
                        <LoadingSpinner className="size-4 shrink-0" />
                      ) : (
                        <span
                          className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-xs ${reachable ? 'bg-green-500/15 text-green-600' : 'bg-muted text-muted-foreground'}`}
                        >
                          {device.status}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
              <div className="mt-2 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep('sign-in')} disabled={connectingId !== null}>
                  Back
                </Button>
                <Button variant="outline" size="sm" onClick={handleRefresh} loading={busy} disabled={busy || connectingId !== null}>
                  Refresh
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
