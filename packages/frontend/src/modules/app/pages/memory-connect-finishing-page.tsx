import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { buildAppAccessPoints } from '@/modules/app/components/app-access-points/app-access-points';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import './memory-connect-finishing-page.css';

/**
 * Full-page interstitial the memory-connect callback redirects to while the
 * connected app restarts to pick up its new credentials. The callback answers
 * the browser immediately (the restart runs server-side); this page watches
 * the app's status and forwards to `next` once it is running again — replacing
 * the old behavior of holding the callback navigation open for the whole
 * compose cycle, where any client-side network blip stranded the user.
 *
 * Lives OUTSIDE the authenticated dashboard layout (no chrome, no
 * SSEProvider — hence polling), and deliberately mirrors the ci-memory consent
 * page's aesthetic so consent → finishing → app reads as one flow.
 */

const POLL_INTERVAL_MS = 2000;
/** Beat between "running" and the hop, so the app's own gateway can start listening. */
const OPEN_APP_GRACE_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;

/** Trusted install URN of the first-party Companion Memory app (logo tile). */
const CI_MEMORY_URN = 'ci-memory:ci-marketplace';

/** Statuses that mean the restart is not going to complete on its own. */
const DOWN_STATUSES = new Set(['stopped', 'missing', 'install_failed', 'uninstalling', 'uninstalled']);

/**
 * Validate the `?next=` destination. The backend redirects here with an
 * already-validated `next`, but the param is attacker-craftable as a bare SPA
 * link — so only honor it when it is http(s) AND its origin is the Hub's own
 * or one of the app's known access points; otherwise fall back to the app's
 * best access-point URL (active first). Exported for tests.
 */
export function resolveSafeTarget(
  rawNext: string | null,
  accessPoints: Array<{ url: string | null; state: string }>,
  currentOrigin: string,
): string | null {
  const urls = accessPoints.map((point) => point.url).filter((url): url is string => Boolean(url));
  const allowedOrigins = new Set<string>([currentOrigin]);

  for (const url of urls) {
    try {
      allowedOrigins.add(new URL(url).origin);
    } catch {
      /* skip unparseable */
    }
  }

  if (rawNext) {
    try {
      const parsed = new URL(rawNext, currentOrigin);

      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && allowedOrigins.has(parsed.origin)) {
        return parsed.toString();
      }
    } catch {
      /* fall through to the derived fallback */
    }
  }

  const active = accessPoints.find((point) => point.state === 'active' && point.url);

  return active?.url ?? urls[0] ?? null;
}

type Phase = 'connecting' | 'ready' | 'error' | 'timeout';

const FinishingContent = ({ appUrn, rawNext }: { appUrn: string; rawNext: string | null }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appContext = useAppContext();
  const [timedOut, setTimedOut] = useState(false);

  const { data, isError } = useQuery({
    ...getAppOptions({ path: { urn: appUrn } }),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  const app = data?.app;
  const info = data?.info;
  const status = app?.status;
  const appName = info?.name ?? appUrn.split(':')[0];

  // The allowlist/fallback must not be derived from the provider's loading
  // defaults (empty userSettings) — hold the hop until the context is real.
  const contextReady = !appContext.isLoading;
  const { userSettings, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn, tailscaleHttpsEnabled } = appContext;

  const target = useMemo(() => {
    if (!contextReady) {
      return null;
    }

    const accessPoints = info
      ? buildAppAccessPoints({
          app,
          info,
          sslPort: userSettings.sslPort,
          internalIp: userSettings.internalIp,
          publicDomain: userSettings.domain,
          cloudflareAvailable,
          tailscaleAvailable,
          tailscaleNodeFqdn,
          tailscaleHttpsEnabled,
          organizationSlug: userSettings.ciHubOrganizationSlug,
          deviceSlug: userSettings.ciHubDeviceSlug,
          hubSubdomain: userSettings.ciHubHubSubdomain,
        })
      : [];

    return resolveSafeTarget(rawNext, accessPoints, window.location.origin);
  }, [contextReady, app, info, rawNext, userSettings, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn, tailscaleHttpsEnabled]);

  // Ready wins over timeout so a late recovery still self-resolves; a query
  // error only counts once there is no data at all (transient poll failures
  // keep the last snapshot and the interval keeps refetching).
  const phase: Phase =
    contextReady && status === 'running'
      ? 'ready'
      : timedOut
        ? 'timeout'
        : (data && !app) || (isError && !data) || (status && DOWN_STATUSES.has(status))
          ? 'error'
          : 'connecting';

  useEffect(() => {
    const id = window.setTimeout(() => setTimedOut(true), POLL_TIMEOUT_MS);

    return () => window.clearTimeout(id);
  }, []);

  // Timer-with-cleanup (StrictMode-safe): the double mount clears and
  // reschedules; navigation fires once, after the grace beat.
  useEffect(() => {
    if (phase !== 'ready' || !target) {
      return;
    }

    const id = window.setTimeout(() => window.location.assign(target), OPEN_APP_GRACE_MS);

    return () => window.clearTimeout(id);
  }, [phase, target]);

  const failed = phase === 'error' || phase === 'timeout';

  return (
    <div className="mcf-page">
      <main className="mcf-card">
        <div className="mcf-brand">
          <AppLogo urn={appUrn} size={56} alt={appName} />
          <span className="mcf-brand-link" aria-hidden="true">
            <svg
              aria-hidden="true"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="4" y1="12" x2="18" y2="12" />
              <polyline points="12 6 18 12 12 18" />
            </svg>
          </span>
          <AppLogo urn={CI_MEMORY_URN} size={56} alt="Companion Memory" />
        </div>

        <div className="mcf-status" role="status" aria-busy={phase === 'connecting'}>
          {phase === 'ready' ? (
            <CheckCircle2 className="mcf-check" size={34} aria-hidden="true" />
          ) : failed ? null : (
            <div className="mcf-spinner" aria-hidden="true" />
          )}
        </div>

        {phase === 'ready' ? (
          <>
            <h1 className="mcf-title">{t('MEMORY_CONNECT_FINISHING_READY', { name: appName })}</h1>
            {!target && (
              <div className="mcf-actions">
                <button type="button" className="mcf-btn mcf-btn-secondary" onClick={() => navigate('/home')}>
                  {t('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD')}
                </button>
              </div>
            )}
          </>
        ) : failed ? (
          <>
            <h1 className="mcf-title">{t('MEMORY_CONNECT_FINISHING_ERROR_TITLE')}</h1>
            <p className="mcf-desc">
              {t(phase === 'timeout' ? 'MEMORY_CONNECT_FINISHING_TIMEOUT_DESC' : 'MEMORY_CONNECT_FINISHING_ERROR_DESC', { name: appName })}
            </p>
            <div className="mcf-actions">
              {target && (
                <button type="button" className="mcf-btn mcf-btn-primary" onClick={() => window.location.assign(target)}>
                  {t('MEMORY_CONNECT_FINISHING_OPEN_ANYWAY')}
                </button>
              )}
              <button type="button" className="mcf-btn mcf-btn-secondary" onClick={() => navigate('/home')}>
                {t('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD')}
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mcf-title">{t('MEMORY_CONNECT_FINISHING_TITLE')}</h1>
            <p className="mcf-desc">{t('MEMORY_CONNECT_FINISHING_DESC', { name: appName })}</p>
          </>
        )}
      </main>
    </div>
  );
};

export default function MemoryConnectFinishingPage() {
  const { isLoggedIn, isLoading } = useUserContext();
  const [params] = useSearchParams();
  const appUrn = params.get('app');

  // Gate on the loading flag BEFORE isLoggedIn: the context defaults to
  // logged-out while it resolves, which would flash-bounce a valid session
  // to /login.
  if (isLoading) {
    return <PageLoadingSpinner />;
  }

  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  if (!appUrn) {
    return <Navigate to="/home" replace />;
  }

  return (
    <AppContextProvider>
      <FinishingContent appUrn={appUrn} rawNext={params.get('next')} />
    </AppContextProvider>
  );
}
