import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { publishHubsToIntents } from '@/lib/app-intents';
import { hubAuthFlowPolicy, readHubAuthFlow } from '@/lib/hub-auth-flow';
import { initMobileConnection, setHubConnection, usesCloudConnect } from '@/lib/mobile-connection';
import { resolveHubConnection } from '@/lib/lan-direct-connect';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { redirect, useNavigate } from 'react-router';
import { markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';
import { rememberPortalAccountEmail } from '@/lib/portal-session-hint';
import { emailFromIdToken, loginWithPortalOidc, OidcCancelledError, resumePendingOidcLogin } from '../oidc';
import {
  establishHubSessionFromPortal,
  type HubDevice,
  listHubDevices,
  type PortalAuth,
  readPersistedPortalUrl,
  readStoredPortalAuth,
  writePortalAuth,
} from '../portal-client';

/**
 * Mobile-only entry screen. Portal OIDC in an in-app browser, then pick a Hub.
 * Email/password and a custom Portal URL live under Advanced — same split as
 * Memory's `/device-connect` landing.
 */
export async function clientLoader() {
  const { hubBaseUrl } = await initMobileConnection();
  if (hubBaseUrl) {
    // A Hub is already chosen — go to that Hub's login. Redirecting to `/`
    // leaves the phone on the root bootstrap spinner while registration
    // probes the remote appliance (often forever from ios:dev).
    return redirect('/login');
  }
  if (usesCloudConnect()) {
    // Stay here. Redirecting "not Tauri-mobile yet" back to `/` is what
    // blanks the ios:dev connect screen after the first paint.
    return null;
  }
  // Mac / Linux / Windows (browser or desktop Tauri) never see this screen.
  return redirect('/');
}

type Step = 'sign-in' | 'pick';

const TOUCH = 'min-h-[44px]';
const CI_LOGO = '/2024_CI__LogoMark_Color_med.svg';

export default function ConnectPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('sign-in');
  const [portalUrl] = useState(readPersistedPortalUrl);
  const [auth, setAuth] = useState<PortalAuth | null>(null);
  const [devices, setDevices] = useState<HubDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [oidcController, setOidcController] = useState<AbortController | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);

  // Safari → "Open with Companion Hub" often cold-starts the app. PKCE state
  // lives in localStorage; Rust stashed the callback URL. Email sign-in on
  // Advanced stashes Portal auth in sessionStorage. Finish the exchange on
  // mount, when we become visible again, and when Rust emits the callback.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const finish = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const tokens = await resumePendingOidcLogin();
        const stored = tokens ? null : readStoredPortalAuth();
        if (cancelled || (!tokens && !stored)) return;
        const portalEmail = tokens ? emailFromIdToken(tokens.idToken) : null;
        if (portalEmail) rememberPortalAccountEmail(portalEmail);
        setBusy(true);
        setSignInError(null);
        let portalAuth: PortalAuth;
        if (tokens) {
          portalAuth = {
            token: tokens.accessToken,
            cookie: null,
            kind: 'oauth',
            ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
          };
        } else if (stored) {
          portalAuth = stored;
        } else {
          return;
        }
        writePortalAuth(portalAuth);
        setAuth(portalAuth);
        const hubs = await listHubDevices(portalAuth, portalUrl);
        if (cancelled) return;
        setDevices(hubs);
        void publishHubsToIntents(hubs.map((d) => ({ id: d.id, name: d.name, hubUrl: d.hubUrl })));
        setStep('pick');
      } catch (err) {
        if (!cancelled && !(err instanceof OidcCancelledError)) {
          const message = err instanceof Error ? err.message : t('MOBILE_CONNECT_SIGNIN_FAILED');
          // Safari + resume both redeem the same one-time code. The winner
          // already listed Hubs; "invalid code" from the loser is noise.
          if (/invalid.?code|invalid_grant/i.test(message)) return;
          setSignInError(message);
          toast.error(message);
        }
      } finally {
        inFlight = false;
        if (!cancelled) setBusy(false);
      }
    };
    void finish();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void finish();
    };
    document.addEventListener('visibilitychange', onVisible);
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<string>('deep-link-oidc', () => void finish()))
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      unlisten?.();
    };
  }, [portalUrl, t]);

  const loadDevices = async (portalAuth: PortalAuth) => {
    writePortalAuth(portalAuth);
    setAuth(portalAuth);
    const hubs = await listHubDevices(portalAuth, portalUrl);
    setDevices(hubs);
    void publishHubsToIntents(hubs.map((d) => ({ id: d.id, name: d.name, hubUrl: d.hubUrl })));
    setStep('pick');
  };

  const handleOidcLogin = async () => {
    if (!hubAuthFlowPolicy(readHubAuthFlow()).usesPortalPkce) {
      return;
    }
    const controller = new AbortController();
    setOidcController(controller);
    setBusy(true);
    setSignInError(null);
    try {
      // Cloud-connect PKCE only — Hub /login OIDC is portal/start + deep-link-auth.
      const tokens = await loginWithPortalOidc(portalUrl, { signal: controller.signal });
      const portalEmail = emailFromIdToken(tokens.idToken);
      if (portalEmail) rememberPortalAccountEmail(portalEmail);
      await loadDevices({
        token: tokens.accessToken,
        cookie: null,
        kind: 'oauth',
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
      });
    } catch (err) {
      if (!(err instanceof OidcCancelledError)) {
        const message = err instanceof Error ? err.message : t('MOBILE_CONNECT_SIGNIN_FAILED');
        setSignInError(message);
        toast.error(message);
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
    if (!device.hubUrl) return;
    setConnectingId(device.id);
    try {
      const lanCandidate = device.lanUrl || device.lanIp;
      const hubUrl = lanCandidate
        ? (
            await resolveHubConnection({
              lanAddress: lanCandidate,
              remoteTunnelUrl: device.hubUrl,
              timeoutMs: 1200,
            })
          ).baseUrl
        : device.hubUrl;
      await setHubConnection(hubUrl);
      // Cloud connect already signed this person in. The Hub session is that
      // same account. A Hub that cannot take the token still has its own sheet.
      if (auth?.idToken) {
        const session = await establishHubSessionFromPortal(hubUrl, auth.idToken);
        if (session) {
          setTauriSessionId(session.sessionId);
          markHubSessionIssuedAt();
          window.location.assign(session.redirectPath || '/home');
          return;
        }
      }
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('MOBILE_CONNECT_CONNECT_FAILED'));
      setConnectingId(null);
    }
  };

  if (step === 'sign-in') {
    return (
      <div className="safe-area-inset flex min-h-dvh flex-col items-center justify-center gap-5 overflow-y-auto px-8">
        <img src={CI_LOGO} alt="" className="aspect-square w-[min(48vw,12rem)]" />
        <div className="flex w-full max-w-sm flex-col items-center gap-3">
          <Button
            type="button"
            size="lg"
            className={`w-full px-10 ${TOUCH}`}
            onClick={() => void handleOidcLogin()}
            loading={busy}
            disabled={busy}
            data-testid="oidc-login-btn"
          >
            {t('MOBILE_CONNECT_OIDC_BUTTON')}
          </Button>
          {signInError ? (
            <p className="text-center text-sm text-destructive" data-testid="connect-signin-error" role="alert">
              {signInError}
            </p>
          ) : null}
          {oidcController ? (
            <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
              <span>{t('MOBILE_CONNECT_OIDC_HINT')}</span>
              <Button type="button" variant="ghost" size="sm" className={TOUCH} onClick={() => oidcController.abort()} data-testid="cancel-oidc-btn">
                {t('MOBILE_CONNECT_CANCEL')}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="py-2 text-xs text-muted-foreground underline"
              onClick={() => navigate('/connect/advanced')}
              data-testid="advanced-link"
            >
              {t('MOBILE_CONNECT_ADVANCED')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="safe-area-inset flex min-h-dvh flex-col items-stretch justify-start overflow-y-auto sm:items-center sm:justify-center">
      <Card className="mx-auto w-full max-w-md shrink-0">
        <CardHeader>
          <CardTitle>{t('MOBILE_CONNECT_PICK_TITLE')}</CardTitle>
          <CardDescription>{t('MOBILE_CONNECT_PICK_DESC')}</CardDescription>
        </CardHeader>
        <CardContent>
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
                    onClick={() => void handleConnect(device)}
                    data-testid={`hub-row-${device.id}`}
                    className="flex min-h-[56px] items-center justify-between gap-3 rounded-md border border-input p-4 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{device.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{device.hubUrl ?? t('MOBILE_CONNECT_NO_ADDRESS')}</div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-sm ${active ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-muted text-foreground/80'}`}
                    >
                      {connectingId === device.id ? t('MOBILE_CONNECT_CONNECTING') : reachable ? device.status : t('MOBILE_CONNECT_UNREACHABLE')}
                    </span>
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
                onClick={() => void handleRefresh()}
                loading={busy}
                disabled={busy || connectingId !== null}
                data-testid="refresh-hubs-btn"
              >
                {t('MOBILE_CONNECT_REFRESH')}
              </Button>
            </div>
            <Button type="button" variant="ghost" className={TOUCH} onClick={() => navigate('/connect/advanced')} disabled={connectingId !== null}>
              {t('MOBILE_CONNECT_ADVANCED')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
