import { appContextOptions, checkAvailabilityOptions, getAppOptions, getServeStatusOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { useUserContext } from '@/context/user-context';
import { buildAppAccessPoints, buildTailscaleServedPortSet } from '@/modules/app/components/app-access-points/app-access-points';
import type { AppStatus } from '@/types/app.types';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
 * page's aesthetic so consent → finishing → app reads as one flow. App-context
 * data is read through a page-local query (not AppContextProvider) so a failed
 * fetch can retry on an interval instead of parking the flow, and so this cold
 * page doesn't trigger the provider's dashboard prefetches.
 *
 * "Running" is necessary but not sufficient for the hop: a freshly (re)installed
 * app's public hostname can lag its container (Cloudflare DNS / tunnel-route
 * propagation), and navigating then dumps the user on a Cloudflare error page
 * for the 5–10s the route needs. So when the target leaves the Hub's origin,
 * the page also polls the backend's check-availability probe (the same one the
 * dashboard's Open button uses — server-side, so a CF 530/1033 error page is
 * actually detectable, which a browser-side opaque no-cors fetch can't do) and
 * holds on a "preparing the app's web address" state until the URL answers.
 */

const POLL_INTERVAL_MS = 2000;
/** Poll cadence once the outcome looks settled (timed out, or a down status that
 *  may yet recover) — late recovery still self-resolves, without an abandoned tab
 *  hammering the backend every 2s. */
const SLOW_POLL_INTERVAL_MS = 15_000;
/** Beat between "running" and the hop, so the app's own gateway can start listening. */
const OPEN_APP_GRACE_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;
/** Retry cadence for the app-context query while it has no data (initial blip). */
const CONTEXT_RETRY_INTERVAL_MS = 5000;
/** Poll cadence for the public-URL probe while the app's address propagates. */
const PROPAGATION_POLL_MS = 2500;
/**
 * Give up holding the hop after this long in the propagating state and show the
 * timeout card (with "Open anyway") instead — its own window, not a slice of
 * POLL_TIMEOUT_MS, so a slow restart can't eat the propagation budget.
 */
const PROPAGATION_TIMEOUT_MS = 60_000;

/** Trusted install URN of the first-party Companion Memory app (logo tile). */
const CI_MEMORY_URN = 'ci-memory:ci-marketplace';

/**
 * Statuses that mean the restart is not going to complete on its own. Typed
 * against the generated status union so a member that drifts out of the enum
 * (or a typo) is a compile error, not dead code; post-uninstall shows up as
 * `app: null`, handled separately.
 */
const DOWN_STATUSES: ReadonlySet<AppStatus> = new Set<AppStatus>(['stopped', 'missing', 'install_failed', 'uninstalling']);

interface AppSnapshot {
  app?: { status: AppStatus } | null;
}

/**
 * Whether the poll can stop for good: the app is running (we're navigating
 * away) or its row is gone (uninstalled — nothing will come back). A down
 * status is deliberately NOT settled: a slow restart can momentarily report
 * `stopped` (e.g. a queue RPC timeout mid-compose) and then recover, so the
 * poll keeps running — at the slow cadence — and a later flip to `running`
 * still forwards the user. A fetch failure is likewise not settled: React
 * Query keeps the last snapshot, so a transient blip never stops the poll.
 * Exported for tests.
 */
export function isPollSettled(data: AppSnapshot | undefined): boolean {
  if (!data) {
    return false;
  }

  if (!data.app) {
    return true;
  }

  return data.app.status === 'running';
}

export type Phase = 'connecting' | 'propagating' | 'ready' | 'error' | 'timeout';

/**
 * Whether the check-availability probe reports the app's public URL is serving.
 * The generated client types the response `unknown`, so read the one field we
 * need here with a single strict-boolean check — used by BOTH the refetch-stop
 * condition and the reachability gate so they can never disagree on a truthy
 * non-`true` value. Exported for tests.
 */
export function isProbeAvailable(payload: unknown): boolean {
  return (payload as { available?: unknown } | undefined)?.available === true;
}

/**
 * Whether the hop target leaves the Hub's own origin — only then is the
 * public-URL probe worth gating on. A same-origin `next` (e.g. back to the
 * app-detail page the user connected from) is served by the very origin the
 * user is already browsing, so there is nothing to wait for. Unparseable
 * targets don't gate either: resolveSafeTarget already rejected anything
 * that isn't a hub/app http(s) URL. Exported for tests.
 */
export function isCrossOriginTarget(target: string | null, currentOrigin: string): boolean {
  if (!target) {
    return false;
  }

  try {
    return new URL(target, currentOrigin).origin !== currentOrigin;
  } catch {
    return false;
  }
}

/**
 * Precedence is load-bearing: `ready` wins over everything (a late recovery
 * self-resolves even after an error or timeout card is showing); a definitive
 * failure (`error` — a down status or a vanished row) wins over the softer
 * `timeout` copy so the message never downgrades from "failed" to "taking
 * longer than expected". A transient fetch blip leaves the last snapshot (or no
 * data) in place, which reads as `connecting` — the poll keeps trying rather
 * than flashing a false failure card. Exported for tests.
 */
export function derivePhase(data: AppSnapshot | undefined, timedOut: boolean): Phase {
  const status = data?.app?.status;

  if (status === 'running') {
    return 'ready';
  }

  if ((data && !data.app) || (status !== undefined && DOWN_STATUSES.has(status))) {
    return 'error';
  }

  if (timedOut) {
    return 'timeout';
  }

  return 'connecting';
}

/**
 * Validate the `?next=` destination. The backend redirects here with an
 * already-validated `next`, but the param is attacker-craftable as a bare SPA
 * link — so only honor it when it is http(s) AND its origin is the Hub's own
 * or one of the app's known access points; otherwise fall back to the app's
 * best access-point URL. Exported for tests.
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

  // Fall back ONLY to an access point that is actually serving the app.
  // A derivable-but-unprovisioned URL (state 'available'/'unavailable' with a
  // non-null url) would auto-navigate the user to a dead host; null instead
  // keeps them on the page's safe dashboard action.
  const active = accessPoints.find((point) => point.state === 'active' && point.url);

  return active?.url ?? null;
}

const FinishingContent = ({ appUrn, rawNext }: { appUrn: string; rawNext: string | null }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [timedOut, setTimedOut] = useState(false);
  const [propagationTimedOut, setPropagationTimedOut] = useState(false);

  const appQuery = useQuery({
    ...getAppOptions({ path: { urn: appUrn } }),
    // Poll until we're leaving (running) or the app's row is gone; a down or
    // still-transitioning app keeps polling so a late recovery self-resolves.
    // Slow the cadence once we've timed out or landed on a (possibly transient)
    // down status, so an abandoned tab doesn't hit the backend every 2s forever.
    refetchInterval: (query) => {
      const snapshot = query.state.data;

      if (isPollSettled(snapshot)) {
        return false;
      }

      const status = snapshot?.app?.status;
      const settledSlow = timedOut || (status !== undefined && DOWN_STATUSES.has(status));

      return settledSlow ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: true,
  });

  const { data } = appQuery;
  const app = data?.app;
  const info = data?.info;
  // Only ever display a SERVER-CONFIRMED name: the URN is raw query-string text,
  // and interpolating it into first-party copy would let a crafted link put
  // arbitrary words in the Hub's mouth.
  const appName = info?.name;

  // Page-local app-context read (settings needed for the origin allowlist).
  // Unlike AppContextProvider — which swallows errors into empty defaults and
  // never refetches — a failure here retries on an interval, so a transient
  // blip at page load can't permanently strand the hop.
  const contextQuery = useQuery({
    ...appContextOptions(),
    staleTime: 30_000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    refetchInterval: (query) => (query.state.data ? false : CONTEXT_RETRY_INTERVAL_MS),
  });
  const ctx = contextQuery.data;

  const { data: serveStatus } = useQuery({
    ...getServeStatusOptions(),
    select: (payload) => payload as { entries: Array<{ listenPort?: number }> },
    enabled: Boolean(ctx?.tailscaleAvailable),
  });
  const tailscaleServedPorts = useMemo(() => buildTailscaleServedPortSet(serveStatus?.entries ?? []), [serveStatus?.entries]);

  const target = useMemo(() => {
    // Never derive the allowlist/fallback from missing context or app info —
    // an empty-settings allowlist would reject the validated next and could
    // fall back to a bogus local URL.
    if (!ctx || !info) {
      return null;
    }

    const { userSettings } = ctx;
    const accessPoints = buildAppAccessPoints({
      app,
      info,
      sslPort: userSettings.sslPort,
      internalIp: userSettings.internalIp,
      publicDomain: userSettings.domain,
      cloudflareAvailable: ctx.cloudflareAvailable,
      tailscaleAvailable: ctx.tailscaleAvailable,
      tailscaleNodeFqdn: ctx.tailscaleNodeFqdn,
      tailscaleHttpsEnabled: ctx.tailscaleHttpsEnabled,
      tailscaleServedPorts,
      organizationSlug: userSettings.ciHubOrganizationSlug,
      deviceSlug: userSettings.ciHubDeviceSlug,
      hubSubdomain: userSettings.ciHubHubSubdomain,
    });

    return resolveSafeTarget(rawNext, accessPoints, window.location.origin);
  }, [ctx, app, info, rawNext, tailscaleServedPorts]);

  const restartPhase = derivePhase(data, timedOut);

  // Public-URL probe: only once the restart is done AND the hop actually leaves
  // this origin. Server-side (the backend fetches the URL itself), so a
  // Cloudflare 530/1033 interstitial — invisible to a browser-side opaque
  // fetch — reads as "not available yet".
  const gateOnReachability = isCrossOriginTarget(target, window.location.origin);
  const availabilityQuery = useQuery({
    ...checkAvailabilityOptions({ path: { urn: appUrn } }),
    enabled: restartPhase === 'ready' && gateOnReachability,
    // Even after the propagation window lapses into the timeout card, keep
    // probing at the slow cadence — a late DNS/tunnel success still flips the
    // page to ready and forwards the user (mirrors the status poll's design).
    refetchInterval: (query) => {
      if (isProbeAvailable(query.state.data)) {
        return false;
      }

      return propagationTimedOut ? SLOW_POLL_INTERVAL_MS : PROPAGATION_POLL_MS;
    },
    refetchIntervalInBackground: true,
    retry: 2,
  });

  // Fail OPEN on a broken probe (query error after retries): the probe is a
  // UX nicety; a Hub-side hiccup in it must not strand a user whose app is in
  // fact up. Worst case they briefly see the Cloudflare page — today's behavior.
  const targetReachable = !gateOnReachability || isProbeAvailable(availabilityQuery.data) || availabilityQuery.isError;

  // Layered on top of derivePhase so its exported contract (and tests) stay
  // intact. Precedence mirrors the status phases: a late probe success wins
  // over the propagation timeout, so the card self-resolves.
  const phase: Phase = restartPhase === 'ready' && !targetReachable ? (propagationTimedOut ? 'timeout' : 'propagating') : restartPhase;
  // The timeout card doubles for both failure modes; pick the accurate copy.
  const timedOutWhilePropagating = phase === 'timeout' && restartPhase === 'ready';

  useEffect(() => {
    const id = window.setTimeout(() => setTimedOut(true), POLL_TIMEOUT_MS);

    return () => window.clearTimeout(id);
  }, []);

  // Separate window for the propagating hold (StrictMode-safe, like the grace
  // timer below). Latches: once true it stays true, so the card can't flap back
  // to the spinner — only a real probe success moves the page forward.
  useEffect(() => {
    if (phase !== 'propagating') {
      return;
    }

    const id = window.setTimeout(() => setPropagationTimedOut(true), PROPAGATION_TIMEOUT_MS);

    return () => window.clearTimeout(id);
  }, [phase]);

  // Timer-with-cleanup (StrictMode-safe): the double mount clears and
  // reschedules; navigation fires once, after the grace beat. `replace`, not
  // `assign`: the interstitial must not stay in history, or Back from the app
  // lands here and immediately re-forwards — an unescapable loop.
  useEffect(() => {
    if (phase !== 'ready' || !target) {
      return;
    }

    const id = window.setTimeout(() => window.location.replace(target), OPEN_APP_GRACE_MS);

    return () => window.clearTimeout(id);
  }, [phase, target]);

  const failed = phase === 'error' || phase === 'timeout';

  // Interpolate the name only when the server confirmed it; otherwise use the
  // nameless copy variant. The named strings wrap {{name}} in <strong> so the
  // app name stands out against the dimmed body copy — rendered through <Trans>
  // (not t()) so that markup becomes a real element, never literal text.
  const named = (key: string, genericKey: string) =>
    appName ? <Trans t={t} i18nKey={key} values={{ name: appName }} components={{ strong: <strong className="mcf-app" /> }} /> : t(genericKey);

  // In-place SPA navigation on purpose — never window.open/a new tab. When the
  // connect flow was started from the Tauri desktop app, this page is running
  // inside its webview (at the Hub's public origin, where no Tauri APIs are
  // injected to even detect the shell): an in-place navigate keeps the user in
  // that same window, whereas a popup would be blocked or orphan a chromeless
  // webview. In a regular browser it is simply the dashboard route.
  const dashboardButton = (
    <button type="button" className="mcf-btn mcf-btn-secondary" onClick={() => navigate('/home')}>
      {t('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD')}
    </button>
  );

  return (
    <div className="mcf-page">
      {/* A <div>, not a <main>: the app shell already renders <main id="root">,
          so a nested <main> would be an invalid second landmark — and it would
          inherit app.css's global `main { height: 100% }`, filling this box and
          defeating the centering. */}
      <div className="mcf-card">
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

        <div className="mcf-status" role="status" aria-busy={phase === 'connecting' || phase === 'propagating'}>
          {phase === 'ready' ? (
            <CheckCircle2 className="mcf-check" size={34} aria-hidden="true" />
          ) : failed ? null : (
            <div className="mcf-spinner" aria-hidden="true" />
          )}
        </div>

        {phase === 'ready' ? (
          <>
            <h1 className="mcf-title">
              {target ? named('MEMORY_CONNECT_FINISHING_READY', 'MEMORY_CONNECT_FINISHING_READY_GENERIC') : t('MEMORY_CONNECT_FINISHING_READY_DONE')}
            </h1>
            {!target && <div className="mcf-actions">{dashboardButton}</div>}
          </>
        ) : phase === 'propagating' ? (
          <>
            <h1 className="mcf-title">{named('MEMORY_CONNECT_FINISHING_PROPAGATING_TITLE', 'MEMORY_CONNECT_FINISHING_PROPAGATING_TITLE_GENERIC')}</h1>
            <p className="mcf-desc">{named('MEMORY_CONNECT_FINISHING_PROPAGATING_DESC', 'MEMORY_CONNECT_FINISHING_PROPAGATING_DESC_GENERIC')}</p>
            <div className="mcf-actions">{dashboardButton}</div>
          </>
        ) : failed ? (
          <>
            <h1 className="mcf-title">{t('MEMORY_CONNECT_FINISHING_ERROR_TITLE')}</h1>
            <p className="mcf-desc">
              {phase === 'timeout'
                ? timedOutWhilePropagating
                  ? named('MEMORY_CONNECT_FINISHING_PROPAGATING_TIMEOUT_DESC', 'MEMORY_CONNECT_FINISHING_PROPAGATING_TIMEOUT_DESC_GENERIC')
                  : named('MEMORY_CONNECT_FINISHING_TIMEOUT_DESC', 'MEMORY_CONNECT_FINISHING_TIMEOUT_DESC_GENERIC')
                : named('MEMORY_CONNECT_FINISHING_ERROR_DESC', 'MEMORY_CONNECT_FINISHING_ERROR_DESC_GENERIC')}
            </p>
            <div className="mcf-actions">
              {target && (
                <button type="button" className="mcf-btn mcf-btn-primary" onClick={() => window.location.assign(target)}>
                  {t('APP_ACTION_OPEN_ANYWAY')}
                </button>
              )}
              {dashboardButton}
            </div>
          </>
        ) : (
          <>
            <h1 className="mcf-title">{t('MEMORY_CONNECT_FINISHING_TITLE')}</h1>
            <p className="mcf-desc">{named('MEMORY_CONNECT_FINISHING_DESC', 'MEMORY_CONNECT_FINISHING_DESC_GENERIC')}</p>
          </>
        )}
      </div>
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

  return <FinishingContent appUrn={appUrn} rawNext={params.get('next')} />;
}
