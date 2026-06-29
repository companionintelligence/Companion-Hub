import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { publishHubsToIntents } from '@/lib/app-intents';
import { initMobileConnection, isTauriMobileSync, setHubConnection } from '@/lib/mobile-connection';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { redirect, useNavigate } from 'react-router';
import { loginWithPortalOidc, OidcCancelledError } from '../oidc';
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

// 44px minimum touch target (WCAG 2.5.5 / iOS HIG) — the shared Button/Input
// default to 36px, too small for thumbs, so we bump them on this screen.
const TOUCH = 'min-h-[44px]';

export default function ConnectPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [portalUrl, setPortalUrl] = useState(DEFAULT_PORTAL_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [auth, setAuth] = useState<PortalAuth | null>(null);
  const [devices, setDevices] = useState<HubDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [oidcController, setOidcController] = useState<AbortController | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  // Never render the picker on web/desktop. The loader already redirects
  // off-mobile; this is the belt-and-suspenders guard if the route is reached
  // directly.
  if (!isTauriMobileSync()) {
    return null;
  }

  const loadDevices = async (portalAuth: PortalAuth) => {
    setAuth(portalAuth);
    const hubs = await listHubDevices(portalAuth, portalUrl);
    setDevices(hubs);
    // Make these Hubs resolvable by the "open <name>" App Intent (Siri/Shortcuts).
    void publishHubsToIntents(hubs.map((d) => ({ id: d.id, name: d.name, hubUrl: d.hubUrl })));
    setStep('pick');
  };

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    try {
      await loadDevices(await signInToPortal(email, password, portalUrl));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('MOBILE_CONNECT_SIGNIN_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  const handleOidcLogin = async () => {
    const controller = new AbortController();
    setOidcController(controller);
    setBusy(true);
    try {
      // OIDC (PKCE) login to the Portal via the system browser + cihub:// callback.
      const tokens = await loginWithPortalOidc(portalUrl, { signal: controller.signal });
      await loadDevices({ token: tokens.accessToken, cookie: null });
    } catch (err) {
      if (!(err instanceof OidcCancelledError)) {
        toast.error(err instanceof Error ? err.message : t('MOBILE_CONNECT_SIGNIN_FAILED'));
      }
    } finally {
      setBusy(false);
      setOidcController(null);
    }
  };

  const handleRefresh = async () => {
    if (!auth) return;
    setBusy(true);
    try {
      setDevices(await listHubDevices(auth, portalUrl));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('MOBILE_CONNECT_REFRESH_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (device: HubDevice) => {
    if (!device.hubUrl) return; // unreachable rows are disabled; guard anyway
    setConnectingId(device.id);
    try {
      await setHubConnection(device.hubUrl);
      // Hand off to the existing Hub login (portal SSO / password) for this Hub.
      navigate('/login');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('MOBILE_CONNECT_CONNECT_FAILED'));
      setConnectingId(null);
    }
  };

  return (
    // Top-aligned + scrollable so the on-screen keyboard never hides the inputs;
    // centered on larger screens. `safe-area-inset` keeps content clear of the
    // notch / status bar / home indicator (see globals.css).
    <div className="safe-area-inset flex min-h-dvh flex-col items-stretch justify-start overflow-y-auto sm:items-center sm:justify-center">
      <Card className="mx-auto w-full max-w-md shrink-0">
        <CardHeader>
          <CardTitle>{step === 'sign-in' ? t('MOBILE_CONNECT_TITLE') : t('MOBILE_CONNECT_PICK_TITLE')}</CardTitle>
          <CardDescription>{step === 'sign-in' ? t('MOBILE_CONNECT_DESC') : t('MOBILE_CONNECT_PICK_DESC')}</CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'sign-in' ? (
            <div className="flex flex-col gap-4">
              <Button type="button" className={TOUCH} onClick={handleOidcLogin} loading={busy} disabled={busy} data-testid="oidc-login-btn">
                {t('MOBILE_CONNECT_OIDC_BUTTON')}
              </Button>

              {oidcController ? (
                <div className="flex flex-col items-center gap-2 rounded-md bg-muted/40 p-3 text-center text-xs text-muted-foreground">
                  <span>{t('MOBILE_CONNECT_OIDC_HINT')}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={TOUCH}
                    onClick={() => oidcController.abort()}
                    data-testid="cancel-oidc-btn"
                  >
                    {t('MOBILE_CONNECT_CANCEL')}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    {t('MOBILE_CONNECT_OR_EMAIL')}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <form onSubmit={handleSignIn} className="flex flex-col gap-4">
                    <Input
                      type="email"
                      className={TOUCH}
                      placeholder="you@example.com"
                      autoComplete="username"
                      inputMode="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                    <PasswordInput
                      className={TOUCH}
                      placeholder={t('MOBILE_CONNECT_PASSWORD')}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    {showAdvanced ? (
                      <Input
                        type="url"
                        className={TOUCH}
                        placeholder={t('MOBILE_CONNECT_PORTAL_URL')}
                        inputMode="url"
                        value={portalUrl}
                        onChange={(e) => setPortalUrl(e.target.value)}
                      />
                    ) : (
                      <button type="button" className="self-start py-2 text-xs text-muted-foreground underline" onClick={() => setShowAdvanced(true)}>
                        {t('MOBILE_CONNECT_ADVANCED')}
                      </button>
                    )}
                    <Button type="submit" variant="outline" className={TOUCH} loading={busy} disabled={busy || !email || !password}>
                      {t('MOBILE_CONNECT_EMAIL_BUTTON')}
                    </Button>
                  </form>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {devices.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('MOBILE_CONNECT_NO_HUBS')}</p>
              ) : (
                devices.map((device) => {
                  const reachable = Boolean(device.hubUrl);
                  const active = reachable && device.status === 'active';
                  return (
                    <button
                      key={device.id}
                      type="button"
                      disabled={connectingId !== null || !reachable}
                      onClick={() => handleConnect(device)}
                      data-testid={`hub-row-${device.id}`}
                      className="flex min-h-[56px] items-center justify-between gap-3 rounded-md border border-input p-4 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{device.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{device.hubUrl ?? t('MOBILE_CONNECT_NO_ADDRESS')}</div>
                      </div>
                      {connectingId === device.id ? (
                        <LoadingSpinner className="size-4 shrink-0" />
                      ) : (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${active ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}
                        >
                          {reachable ? device.status : t('MOBILE_CONNECT_UNREACHABLE')}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
              <div className="mt-2 flex items-center justify-between">
                <Button variant="ghost" size="sm" className={TOUCH} onClick={() => setStep('sign-in')} disabled={connectingId !== null}>
                  {t('MOBILE_CONNECT_BACK')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={TOUCH}
                  onClick={handleRefresh}
                  loading={busy}
                  disabled={busy || connectingId !== null}
                  data-testid="refresh-hubs-btn"
                >
                  {t('MOBILE_CONNECT_REFRESH')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
