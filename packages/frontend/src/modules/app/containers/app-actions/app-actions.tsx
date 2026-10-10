import {
  AlertTriangle,
  Ban,
  BrainCircuit,
  CheckCircle,
  CircleStop,
  Download,
  Edit,
  Eraser,
  ExternalLink,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  Settings,
  Trash,
} from 'lucide-react';
import type React from 'react';
import { createElement, useState, useEffect, useRef, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import './app-actions.css';
import { ignoreAppVersionMutation, startAppMutation, unignoreAppVersionMutation } from '@/api-client/@tanstack/react-query.gen';
import type { AppDetails, AppInfo, AppMetadata, AppStatus } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import clsx from 'clsx';
import { Tooltip } from 'react-tooltip';
import { AppDataFolderDialog } from '../../components/dialogs/app-data-folder-dialog/app-data-folder-dialog';
import { CancelInstallDialog } from '../../components/dialogs/cancel-install-dialog/cancel-install-dialog';
import { DisconnectMemoryDialog } from '../../components/dialogs/disconnect-memory-dialog/disconnect-memory-dialog';
import { InstallDialog } from '../../components/dialogs/install-dialog/install-dialog';
import { ResetDialog } from '../../components/dialogs/reset-dialog/reset-dialog';
import { RestartDialog } from '../../components/dialogs/restart-dialog/restart-dialog';
import { StopDialog } from '../../components/dialogs/stop-dialog/stop-dialog';
import { ForceStopDialog } from '../../components/dialogs/force-stop-dialog/force-stop-dialog';
import { UninstallDialog } from '../../components/dialogs/uninstall-dialog/uninstall-dialog';
import { UpdateSettingsDialog } from '../../components/dialogs/update-settings-dialog/update-settings-dialog';
import { useAppStatus } from '../../helpers/use-app-status';
import { useInstallationProgress } from '../../helpers/use-installation-progress';
import { useMemoryConnection } from '../../helpers/use-memory-connection';
import { useLocation, useNavigate, Link, useSearchParams } from 'react-router';
import { invalidateAppQueries, type AppInstallErrorCache } from '../../helpers/app-sse-cache';
import type { AppUrn } from '@ci-hub/common/types';
import { openExternal } from '@/lib/helpers/open-external';
import { canOpenFolderInFileExplorer, openPathInFileExplorer } from '@/lib/helpers/open-folder';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { openExternalWithHubSession } from '@/lib/hub-browser-handoff';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import {
  clearStashedInstallIntentForApp,
  forgetInstallIntentForApp,
  resolvePendingInstallIntent,
  shouldAutoOpenInstall,
} from '@/lib/deep-link-install';
import type { AppUrlAvailability, AppUrlProbeResult } from '../../helpers/use-app-url-availability';
import { checkAvailability } from '@/api-client/sdk.gen';
import { useAppContext } from '@/context/app-context';

function isArchitectureSupported(supported: string[] | undefined, hostArch: string | undefined): boolean {
  if (!hostArch || !supported?.length) return true;
  return supported.includes(hostArch);
}

/**
 * Whether THIS browser can plausibly reach an app's LAN address
 * (`http://<lan-ip>:<port>`). That address is only routable from the appliance's
 * own network, and the availability probe reports it caller-independently, so the
 * one locality signal available on the client is the origin this page was served
 * from: a page on a private/loopback/local-domain host is on the LAN, one on a
 * public tunnel origin is not. Desktop and any ambiguous origin err toward `true`
 * — hiding a working route is worse than showing one a remote user can ignore.
 */
function currentPageCanReachLan(): boolean {
  // A desktop webview origin (tauri://…) says nothing about the network, and the
  // LAN address is opened through the Hub session handoff regardless.
  if (getTauriInvoke()) return true;
  if (typeof window === 'undefined') return true;

  const host = window.location.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;

  // Named local hosts.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // CRITICAL: the private-range checks below must ONLY apply to real IP literals.
  // Applying them to any hostname (e.g. `/^192\.168\./` or `startsWith('fc')`)
  // misclassifies public FQDNs like `192.168.cdn.example.com`, `fcbank.com` or
  // `fd-cdn.example.com` as LAN-reachable, which re-shows the dead "Open on local
  // network" button to a remote browser — the exact failure this gate removes.
  // Kept deliberately in step with the backend's isPrivateHostname (hub-origin.ts):
  // detect the literal first, then classify. See CI-Engineering#75.
  const isIpv4Literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split('.').every((octet) => Number(octet) <= 255);
  const isIpv6Literal = host.includes(':') && /^[0-9a-f:]+$/.test(host);

  if (isIpv4Literal) {
    // loopback / RFC1918 / link-local / CGNAT (100.64.0.0/10).
    return (
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    );
  }

  if (isIpv6Literal) {
    // loopback / ULA (fc00::/7) / link-local (fe80::/10) — matching the backend's
    // stricter regexes rather than a bare startsWith.
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }

  // A non-literal hostname: only the conventional private LAN suffixes qualify.
  return ['.local', '.lan', '.internal', '.home', '.localdomain'].some((suffix) => host.endsWith(suffix));
}

interface IProps {
  app?: AppDetails | null;
  info: AppInfo;
  metadata?: AppMetadata;
  /** Absolute host path of the app's data folder (desktop "Open data folder" button). */
  appDataHostPath?: string | null;
  localDomain?: string;
  sslPort?: number;
  runtimeHealth?: AppRuntimeHealth;
  /**
   * Public-route readiness, owned by the app-detail page (like `runtimeHealth`)
   * and shared with the status pill. Required rather than fetched here so the
   * two surfaces can never disagree about whether the app is reachable.
   */
  urlAvailability: AppUrlAvailability;
  layout?: 'default' | 'hero';
}

interface BtnProps extends ButtonProps {
  IconComponent?: typeof Download;
}

interface IconBtnProps extends ButtonProps {
  icon: typeof Download;
  label: string;
}

const ActionButton: React.FC<BtnProps> = (props) => {
  const { IconComponent, loading, title, className, ...rest } = props;

  // Generate testId from title (e.g., "Start" -> "action-start", "Install" -> "action-install")
  const actionName = title?.toString().toLowerCase().replace(/\s+/g, '-') || 'unknown';
  const testId = loading ? 'action-button-loading' : `action-${actionName}`;

  return (
    <Button data-testid={testId} loading={loading} {...rest} className={clsx('action-button', className)}>
      {title}
      {/* Decorative: the title beside it already names the button, and an icon that repeats it is read out as "Stop Stop". */}
      {IconComponent && <IconComponent className="ml-1" size={14} aria-hidden="true" />}
    </Button>
  );
};

const IconActionButton: React.FC<IconBtnProps> = ({ icon: Icon, label, className, ...props }) => (
  <Button
    type="button"
    size="icon"
    variant="ghost"
    aria-label={label}
    data-testid={`icon-action-${label.toLowerCase().replace(/\s+/g, '-')}`}
    data-tooltip-id="app-actions-tooltip"
    data-tooltip-content={label}
    className={clsx('hero-action-icon', className)}
    {...props}
  >
    <Icon size={16} />
  </Button>
);

const INSTALL_FINALIZING_PROGRESS = 99;

/** "7.2 MB", "412 MB", "1.5 GB": the download under the install progress bar. */
function formatDownloadSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 10) return `${megabytes.toFixed(1)} MB`;
  if (megabytes < 1024) return `${Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

/** Docker often reports a small layer first, so the sizes wait until they add up to a megabyte. */
const DOWNLOAD_SIZE_SHOWN_FROM_BYTES = 1024 * 1024;

// In-progress statuses that render the LoadingButton, mapped to their status label key.
const LOADING_STATUS_LABEL_KEYS: Partial<Record<AppStatus, string>> = {
  installing: 'APP_STATUS_INSTALLING',
  uninstalling: 'APP_STATUS_UNINSTALLING',
  starting: 'APP_STATUS_STARTING',
  stopping: 'APP_STATUS_STOPPING',
  restarting: 'APP_STATUS_RESTARTING',
  updating: 'APP_STATUS_UPDATING',
  resetting: 'APP_STATUS_RESETTING',
  backing_up: 'APP_STATUS_BACKING_UP',
  restoring: 'APP_STATUS_RESTORING',
};

export const AppActions = ({ app, info, metadata, appDataHostPath, runtimeHealth, urlAvailability, layout = 'default' }: IProps) => {
  const installDisclosure = useDisclosure();
  const cancelInstallDisclosure = useDisclosure();
  const stopDisclosure = useDisclosure();
  const forceStopDisclosure = useDisclosure();
  const restartDisclosure = useDisclosure();
  const updateSettingsDisclosure = useDisclosure();
  const uninstallDisclosure = useDisclosure();
  const resetAppDisclosure = useDisclosure();
  const disconnectMemoryDisclosure = useDisclosure();
  const appDataFolderDisclosure = useDisclosure();

  // Local optimistic flag while a cancel is in flight: the backend keeps the app in `installing`
  // until compensation finishes and the `install_cancelled` SSE lands, so we surface "Cancelling…".
  const [isCancellingInstall, setIsCancellingInstall] = useState(false);

  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { architecture } = useAppContext();
  const { setOptimisticStatus } = useAppStatus();
  const installationProgress = useInstallationProgress(app?.status === 'installing' ? (info.urn as AppUrn) : undefined);
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const autoInstallTriggeredRef = useRef(false);
  const memory = useMemoryConnection(info.urn);
  const archSupported = isArchitectureSupported(info.supported_architectures, architecture);
  const showWrongArchitectureToast = useCallback(() => {
    toast.error(
      t('APP_ACTION_WRONG_ARCHITECTURE', {
        arch: architecture,
        arches: (info.supported_architectures ?? []).join(', '),
      }),
    );
  }, [architecture, info.supported_architectures, t]);

  // Opening an app hands the flow to the system browser, which (in the desktop app)
  // holds no Hub session cookie. Only a memory-consumer app matters here: its
  // interstitial navigates to the Hub origin and would otherwise demand a second Hub
  // login, so bridge the desktop session into that browser first. Every other app
  // opens directly — no reason to route them through a Hub round-trip. The bridge
  // fails open, so an unavailable handoff never blocks the open.
  const openExternalUrl = (url: string) => (memory.applicable ? openExternalWithHubSession(url) : openExternal(url));

  // Clear the optimistic "cancelling" flag whenever the status moves, into `installing` too. A queued
  // install is cancelled at once, so install_cancelled can land before the reply that sets the flag,
  // and the app's next install would then start out "Cancelling…" with Cancel disabled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: app?.status is the trigger, not an input.
  useEffect(() => {
    setIsCancellingInstall(false);
  }, [app?.status]);

  const urnParts = info.urn.split(':');
  const appSlug = urnParts[0];
  const storeId = urnParts[1];

  useEffect(() => {
    if (autoInstallTriggeredRef.current) {
      return;
    }

    if (!appSlug || !storeId) {
      return;
    }

    if ((app?.status ?? 'missing') !== 'missing') {
      return;
    }

    if (!shouldAutoOpenInstall(appSlug, storeId, location.search)) {
      return;
    }

    // A link held during setup opens this dialog from the stash while the shell still has it parked;
    // left there, it brought the user back here with the dialog open on the next page load.
    if (!archSupported) {
      autoInstallTriggeredRef.current = true;
      showWrongArchitectureToast();
      void forgetInstallIntentForApp(appSlug, storeId);
      return;
    }

    autoInstallTriggeredRef.current = true;
    installDisclosure.open();
    void forgetInstallIntentForApp(appSlug, storeId);

    if (searchParams.get('install') === '1') {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('install');
      const nextSearch = nextParams.toString();
      void navigate(
        {
          pathname: location.pathname,
          search: nextSearch ? `?${nextSearch}` : '',
        },
        { replace: true },
      );
    }
  }, [
    app?.status,
    appSlug,
    storeId,
    location.pathname,
    location.search,
    navigate,
    searchParams,
    installDisclosure.open,
    archSupported,
    showWrongArchitectureToast,
  ]);

  useEffect(() => {
    if (autoInstallTriggeredRef.current || (app?.status ?? 'missing') !== 'missing') {
      return;
    }

    void (async () => {
      const pending = await resolvePendingInstallIntent();
      if (!pending || pending.appSlug !== appSlug || pending.storeId !== storeId) {
        return;
      }

      autoInstallTriggeredRef.current = true;
      if (!archSupported) {
        showWrongArchitectureToast();
        clearStashedInstallIntentForApp(appSlug, storeId);
        return;
      }
      installDisclosure.open();
      clearStashedInstallIntentForApp(appSlug, storeId);
    })();
  }, [app?.status, appSlug, storeId, installDisclosure.open, archSupported, showWrongArchitectureToast]);

  const versionIsIgnored = app?.ignoredVersion === metadata?.latestVersion;
  const updateAvailable = Number(app?.version ?? 0) < Number(metadata?.latestVersion || 0);

  const startMutation = useMutation({
    ...startAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
      // A pre-flight rejection (e.g. starting an app that was already removed, which
      // throws APP_ERROR_APP_NOT_FOUND before any status update) emits no lifecycle
      // SSE event, and the app-detail query has a 30s staleTime with no refetch
      // interval — so without this the optimistic 'starting' status would spin until
      // a manual reload. Re-sync from the server to clear it (#909).
      invalidateAppQueries(queryClient, info.urn);
    },
    onMutate: () => {
      setOptimisticStatus('starting', info.urn);
    },
  });

  const ignoreVersionMutation = useMutation({
    ...ignoreAppVersionMutation(),
    onSuccess: () => {
      toast.success(t('APP_ACTION_IGNORE_VERSION_SUCCESS'));
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });

  const unignoreVersionMutation = useMutation({
    ...unignoreAppVersionMutation(),
    onSuccess: () => {
      toast.success(t('APP_ACTION_UNIGNORE_VERSION_SUCCESS'));
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });

  const StartButton = (
    <ActionButton
      key="start"
      IconComponent={Play}
      onClick={() => startMutation.mutate({ path: { urn: info.urn } })}
      title={t('APP_ACTION_START')}
      variant="default"
      size="lg"
      className="launch-action-button"
    />
  );
  const LoadingButton = (() => {
    const progress = app?.status === 'installing' ? installationProgress : null;
    const progressValue = progress === null ? 12 : Math.max(8, Math.min(99, progress.percent));

    const cancelling = isCancellingInstall && app?.status === 'installing';
    const statusLabel = cancelling ? t('APP_STATUS_CANCELLING') : t((app?.status && LOADING_STATUS_LABEL_KEYS[app.status]) ?? 'COMMON_INSTALLING');

    let stageText = t('APP_ACTION_PREPARING');
    if (cancelling) {
      stageText = t('APP_STATUS_CANCELLING');
    } else if (progress !== null) {
      if (progress.percent >= INSTALL_FINALIZING_PROGRESS) stageText = t('APP_ACTION_FINALIZING');
      else if (progress.percent >= 60 && (progress.totalBytes ?? 0) >= DOWNLOAD_SIZE_SHOWN_FROM_BYTES)
        stageText = `${t('APP_ACTION_DOWNLOADING')} ${formatDownloadSize(progress.downloadedBytes ?? 0)} / ${formatDownloadSize(progress.totalBytes ?? 0)}`;
      else if (progress.percent >= 60) stageText = t('APP_ACTION_DOWNLOADING');
      else stageText = t('APP_ACTION_PREPARING');
    }

    return (
      <div key="loading" className="installation-progress-shell">
        <ActionButton disabled variant="outline" title={statusLabel} className="installation-progress-button" />
        <div
          className="installation-progress-track"
          role="progressbar"
          aria-label={statusLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress?.percent}
          aria-valuetext={stageText}
        >
          <div className="installation-progress-fill" style={{ width: `${progressValue}%` }} />
        </div>
        <p className="installation-progress-stage">{stageText}</p>
      </div>
    );
  })();

  // Keep the control clickable when unsupported so a tap can toast; style it disabled.
  const InstallButton = (
    <ActionButton
      key="install"
      onClick={archSupported ? installDisclosure.open : showWrongArchitectureToast}
      title={t('COMMON_INSTALL')}
      variant="default"
      size="lg"
      className={clsx('install-action-button', !archSupported && 'opacity-50')}
      aria-disabled={!archSupported}
    />
  );
  const RetryInstallButton = (
    <ActionButton
      key="retry-install"
      IconComponent={RotateCw}
      onClick={archSupported ? installDisclosure.open : showWrongArchitectureToast}
      title={t('APP_ACTION_RETRY_INSTALL')}
      variant="outline"
      size="lg"
      className={clsx('retry-install-action-button', !archSupported && 'opacity-50')}
      aria-disabled={!archSupported}
    />
  );

  // Show install errors surfaced from SSE via query cache
  const { data: installError } = useQuery({
    queryKey: ['app-install-error', info.urn],
    queryFn: () => queryClient.getQueryData<AppInstallErrorCache | null>(['app-install-error', info.urn]) ?? null,
    initialData: () => queryClient.getQueryData<AppInstallErrorCache | null>(['app-install-error', info.urn]) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // `||`, not `??`: an empty/unset mode means a pre-exposureMode install, which
  // is treated as local access — the same fallback the backend applies.
  const exposureMode = app?.exposureMode || 'local';
  const isLocal = exposureMode === 'local';

  // Public-route readiness comes from the page (shared with the status pill);
  // this container only decides how to render it.
  const {
    state: publicUrlState,
    appUrl,
    localUrl,
    statusMessage,
    withinGracePeriod,
    pollingStopped,
    resolvable,
    isResolving,
    resolve: resolveRoute,
    reset: restartProbe,
  } = urlAvailability;

  // Build the Open button area for running apps with GUI
  const renderOpenButtonArea = () => {
    if (info.no_gui) return null;

    // Local mode: always show enabled Open button immediately. The probe is
    // skipped for local access (the LAN address serves as soon as the container
    // binds), so resolve the URL on demand per click — deliberately NOT cached,
    // since a port or exposure change would otherwise keep launching a dead
    // address until the page is remounted.
    if (isLocal) {
      return (
        <ActionButton
          key="open-local"
          IconComponent={ExternalLink}
          onClick={() => {
            checkAvailability({ path: { urn: info.urn }, throwOnError: true })
              .then(({ data }) => {
                const result = (data ?? {}) as AppUrlProbeResult;
                if (result.appUrl) openExternalUrl(result.appUrl);
              })
              .catch(() => {
                // A transient backend/tunnel failure (e.g. a Cloudflare 530
                // while the tunnel reconnects) must not become an unhandled
                // rejection surfaced as a generic error. Tell the user instead.
                toast.error(t('APP_ACTION_COULD_NOT_REACH_HUB'));
              });
          }}
          title={t('APP_ACTION_OPEN')}
          variant="default"
          size="lg"
          className="launch-action-button"
        />
      );
    }

    // Escape hatch offered alongside every not-yet-available state: the probe
    // can be wrong (or merely pessimistic), so never trap the user behind it.
    const openAnywayLink = appUrl ? (
      <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => openExternalUrl(appUrl)}>
        {t('APP_ACTION_OPEN_ANYWAY')}
      </button>
    ) : null;

    // A real alternative route, not just an escape hatch. When the public route
    // is unreachable but the app publishes a LAN port, it is very likely serving
    // there right now — a broken tunnel says nothing about the local network. So
    // offer that as an ENABLED primary action instead of the disabled button this
    // used to show next to a perfectly healthy app (CI-Engineering#75).
    //
    // But `localUrl` is `http://<lan-ip>:<port>`, reachable only from the
    // appliance's own network. `localUrl` itself is caller-independent (the
    // backend attaches it to every verdict), so we gate on THIS page's origin: a
    // dashboard loaded over the public tunnel is a remote browser that cannot
    // reach a 192.168.x address, and offering it that link would just reinstate
    // the dead button. Ambiguous origins err toward showing it.
    const openLocallyButton =
      localUrl && currentPageCanReachLan() ? (
        <ActionButton
          IconComponent={ExternalLink}
          onClick={() => openExternalUrl(localUrl)}
          title={t('APP_ACTION_OPEN_LOCALLY')}
          variant="default"
          size="lg"
          className="launch-action-button"
          data-tooltip-id="app-actions-tooltip"
          data-tooltip-content={t('APP_ACTION_OPEN_LOCALLY_DESC')}
        />
      ) : null;

    // Available — show enabled Open button
    if (publicUrlState === 'ready') {
      return (
        <ActionButton
          key="open"
          IconComponent={ExternalLink}
          onClick={() => appUrl && openExternalUrl(appUrl)}
          title={t('APP_ACTION_OPEN')}
          disabled={!appUrl}
          variant="default"
          size="lg"
          className="launch-action-button"
        />
      );
    }

    // The public route is still coming up. No "Starting…" label and no reason
    // text here: the app HAS started, and the status pill already carries the
    // "Running (DNS propagating...)" explanation — two surfaces saying
    // different things about one concept is what this state used to look like.
    if (publicUrlState === 'propagating' && withinGracePeriod) {
      return (
        <div key="open-propagating" className="flex flex-col items-start gap-1">
          <ActionButton title={t('APP_ACTION_OPEN')} disabled loading size="lg" className="launch-action-button" />
          {openAnywayLink}
        </div>
      );
    }

    // Taking longer than the grace window, but the backend thinks it can repair
    // the route (re-sync DNS / tunnel config) — offer that, or a plain retry
    // once we've stopped probing on our own. `pollingStopped` qualifies on its
    // own: once we have given up there is nothing left to wait for, so a manual
    // retry has to be reachable even for a verdict the backend can't repair
    // (including no verdict at all, when every probe request failed).
    if ((publicUrlState === 'propagating' || publicUrlState === 'unreachable') && (resolvable || pollingStopped)) {
      return (
        <div key="open-resolvable" className="flex flex-col items-start gap-1">
          {/* The LAN route leads first when there is one: it is the action most
              likely to actually work, whereas Resolve only attempts a repair. */}
          {openLocallyButton}
          {pollingStopped ? (
            <ActionButton IconComponent={RotateCw} title={t('COMMON_RETRY')} intent="warning" onClick={restartProbe} />
          ) : (
            <ActionButton
              IconComponent={RotateCw}
              title={t('APP_ACTION_RESOLVE')}
              intent="warning"
              onClick={resolveRoute}
              loading={isResolving}
              disabled={isResolving}
            />
          )}
          {statusMessage && <span className="text-xs text-warning">{statusMessage}</span>}
          {openAnywayLink}
        </div>
      );
    }

    // Any other not-serving verdict — a settled failure the Hub can't repair,
    // or a propagating one past the grace window that arrived without the
    // `resolvable` flag. Both must still show the reason and the escape hatch;
    // falling through to the neutral spinner below would hide both.
    if (publicUrlState === 'unreachable' || publicUrlState === 'propagating') {
      return (
        <div key="open-error" className="flex flex-col items-start gap-1">
          {/* Prefer the working route over a red disabled button. The failed
              public route is still reported below, so the user knows the app is
              only reachable locally rather than silently getting a different URL. */}
          {openLocallyButton ?? <ActionButton IconComponent={AlertTriangle} title={t('APP_ACTION_OPEN')} intent="danger" disabled />}
          {statusMessage && <span className="text-xs text-destructive">{statusMessage}</span>}
          {openAnywayLink}
        </div>
      );
    }

    // Fallback: no verdict yet. Same full-size footprint as the enabled Open
    // button so the spinner state doesn't render smaller.
    return (
      <div key="open-checking" className="flex flex-col items-start gap-1">
        <ActionButton title={t('APP_ACTION_OPEN')} disabled loading size="lg" className="launch-action-button" />
        {openAnywayLink}
      </div>
    );
  };

  // If there was an install error for this app, show it under the open/action area
  const installErrorMessage =
    installError?.errorCode === 'rocm_kfd_missing'
      ? t('APP_ERROR_ROCM_KFD_MISSING')
      : installError?.errorCode === 'network_overlap'
        ? t('APP_ERROR_NETWORK_OVERLAP')
        : installError?.message;
  const installErrorSettingsPath =
    installError?.settingsPath ?? (installError?.errorCode === 'rocm_kfd_missing' ? '/settings?tab=ai&section=rocm' : undefined);

  const InstallErrorMessage = installErrorMessage ? (
    <div
      className={clsx(
        'min-w-0 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive',
        layout === 'hero' && 'hero-inline-install-error',
      )}
      role="alert"
      title={installError?.errorDetail ?? installErrorMessage}
    >
      {layout === 'hero' ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{installErrorMessage}</p>
          </div>
          {installErrorSettingsPath ? (
            <Link to={installErrorSettingsPath} className="shrink-0 font-medium underline underline-offset-2 hover:text-destructive/80">
              {t('APP_ERROR_OPEN_AI_SETTINGS')}
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <p>{installErrorMessage}</p>
          {installErrorSettingsPath ? (
            <Link to={installErrorSettingsPath} className="font-medium underline underline-offset-2">
              {t('APP_ERROR_OPEN_AI_SETTINGS')}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  ) : null;

  const buttons: React.JSX.Element[] = [];
  const secondaryActions: React.JSX.Element[] = [];

  // Desktop shell on the Hub host: open Finder / Explorer / the file manager.
  // Browser (and phone, or desktop without a resolved host path): read-only
  // listing dialog so the action is never a silent no-op.
  const openDataFolderButton = app ? (
    <IconActionButton
      key="open-data-folder"
      icon={FolderOpen}
      label={t('APP_ACTION_OPEN_DATA_FOLDER')}
      onClick={() => {
        if (canOpenFolderInFileExplorer() && appDataHostPath) {
          void openPathInFileExplorer(appDataHostPath);
          return;
        }
        appDataFolderDisclosure.open();
      }}
    />
  ) : null;

  // Companion Memory connect/disconnect, sized to match the Open button and
  // placed just before it (running case). Only for memory-consumer apps; the
  // status itself is shown by the header badge. When Companion Memory isn't
  // installed there is nothing to connect to, so no button is rendered; while it
  // is installed but not yet running the action shows disabled (it can't succeed
  // until ci-memory is up).
  const memoryButton = ((): React.JSX.Element | null => {
    if (!memory.applicable) {
      return null;
    }

    if (memory.connected) {
      return (
        <ActionButton
          key="memory-disconnect"
          IconComponent={BrainCircuit}
          title={t('MEMORY_CONNECT_ACTION_DISCONNECT_MEMORY')}
          onClick={disconnectMemoryDisclosure.open}
          disabled={memory.isDisconnecting}
          variant="outline"
          size="lg"
          className="launch-action-button memory-action-button"
          data-tooltip-id="app-actions-tooltip"
          data-tooltip-content={t('MEMORY_CONNECT_DISCONNECT_DESC')}
        />
      );
    }

    if (memory.memoryReady && memory.connectable) {
      return (
        <ActionButton
          key="memory-connect"
          IconComponent={BrainCircuit}
          title={t('MEMORY_CONNECT_ACTION_CONNECT_MEMORY')}
          onClick={memory.connect}
          variant="outline"
          size="lg"
          className="launch-action-button memory-action-button"
          data-tooltip-id="app-actions-tooltip"
          data-tooltip-content={t('MEMORY_CONNECT_DESC')}
        />
      );
    }

    // ci-memory is up, but this browser cannot start a connect — the Hub's public
    // origin is down and we're not on its LAN, or ci-memory is LAN-only and we
    // are not. Keep the affordance visible (this surface blocks nothing) but say
    // WHY: this branch used to render the enabled button with `disabled` derived
    // from a null URL and the generic "what connecting does" tooltip, so the user
    // got a dead control with no explanation. Tooltip anchored on the wrapper
    // span because a disabled button has `pointer-events: none`.
    if (memory.memoryReady) {
      return (
        <span
          key="memory-connect-blocked"
          className="inline-flex"
          data-tooltip-id="app-actions-tooltip"
          data-tooltip-content={t(memory.blockedReasonKey ?? 'MEMORY_CONNECT_DESC')}
        >
          <ActionButton
            IconComponent={BrainCircuit}
            title={t('MEMORY_CONNECT_ACTION_CONNECT_MEMORY')}
            disabled
            variant="outline"
            size="lg"
            className="launch-action-button memory-action-button"
          />
        </span>
      );
    }

    // Companion Memory is installed but not running yet (installing / booting /
    // stopped). Show the action disabled so the affordance stays visible, with a
    // tooltip that says why it's inert — connecting can't succeed until it's up.
    // The tooltip anchor sits on a wrapper span, not the button: a disabled
    // <button> has `pointer-events: none`, so hover would never reach it — the
    // pointer passes through to the span, which is what triggers the tooltip.
    if (memory.memoryInstalled) {
      return (
        <span
          key="memory-connect-pending"
          className="inline-flex"
          data-tooltip-id="app-actions-tooltip"
          data-tooltip-content={memory.providerStatus === 'offline' ? t('MEMORY_CONNECT_OFFLINE_DESC') : t('MEMORY_CONNECT_STARTING_DESC')}
        >
          <ActionButton
            IconComponent={BrainCircuit}
            title={t('MEMORY_CONNECT_ACTION_CONNECT_MEMORY')}
            disabled
            variant="outline"
            size="lg"
            className="launch-action-button memory-action-button"
          />
        </span>
      );
    }

    return null;
  })();

  switch (app?.status ?? 'missing') {
    case 'stopped':
    case 'missing': {
      // No DB row → not installed. An installed row with status "missing" is a
      // legacy/compose-down state and should offer Start, not Install.
      if (!app) {
        buttons.push(InstallButton);
        if (info.urn.split(':')[1] === '_user') {
          secondaryActions.push(
            <IconActionButton key="edit-config" icon={Edit} label={t('CUSTOM_APP_EDIT_CONFIG')} onClick={() => navigate(`/apps/${info.id}/edit`)} />,
            <IconActionButton
              key="remove"
              icon={Trash}
              label={t('COMMON_REMOVE')}
              onClick={uninstallDisclosure.open}
              className="text-destructive hover:text-destructive"
            />,
          );
        }
        break;
      }

      buttons.push(StartButton);
      secondaryActions.push(
        <IconActionButton key="settings" icon={Settings} label={t('COMMON_SETTINGS')} onClick={updateSettingsDisclosure.open} />,
        <IconActionButton key="reset" icon={Eraser} label={t('APP_INSTALL_FORM_RESET')} onClick={resetAppDisclosure.open} />,
        <IconActionButton
          key="remove"
          icon={Trash}
          label={t('COMMON_REMOVE')}
          onClick={uninstallDisclosure.open}
          className="text-destructive hover:text-destructive"
        />,
      );
      if (info.urn.split(':')[1] === '_user') {
        secondaryActions.push(
          <IconActionButton key="edit-config" icon={Edit} label={t('CUSTOM_APP_EDIT_CONFIG')} onClick={() => navigate(`/apps/${info.id}/edit`)} />,
        );
      }
      if (openDataFolderButton) secondaryActions.push(openDataFolderButton);
      if (updateAvailable && !versionIsIgnored) {
        secondaryActions.push(
          <IconActionButton
            key="update"
            icon={Download}
            label={t('COMMON_UPDATE')}
            onClick={() => navigate(`${location.pathname}/update`, { state: { from: location.pathname } })}
          />,
          <IconActionButton
            key="ignore-version"
            icon={Ban}
            label={t('APP_ACTION_IGNORE_VERSION')}
            onClick={() => ignoreVersionMutation.mutate({ path: { urn: info.urn } })}
            disabled={ignoreVersionMutation.isPending}
          />,
        );
      } else if (versionIsIgnored) {
        secondaryActions.push(
          <IconActionButton
            key="unignore-version"
            icon={CheckCircle}
            label={t('APP_ACTION_UNIGNORE_VERSION')}
            onClick={() => unignoreVersionMutation.mutate({ path: { urn: info.urn } })}
            disabled={unignoreVersionMutation.isPending}
          />,
        );
      }
      break;
    }
    case 'running': {
      secondaryActions.push(
        <IconActionButton key="stop" icon={Pause} label={t('COMMON_STOP')} onClick={stopDisclosure.open} />,
        <IconActionButton key="restart" icon={RotateCw} label={t('COMMON_RESTART')} onClick={restartDisclosure.open} />,
        <IconActionButton key="settings" icon={Settings} label={t('COMMON_SETTINGS')} onClick={updateSettingsDisclosure.open} />,
        <IconActionButton key="reset" icon={Eraser} label={t('APP_INSTALL_FORM_RESET')} onClick={resetAppDisclosure.open} />,
        ...(openDataFolderButton ? [openDataFolderButton] : []),
        <IconActionButton
          key="remove"
          icon={Trash}
          label={t('COMMON_REMOVE')}
          onClick={uninstallDisclosure.open}
          className="text-destructive hover:text-destructive"
        />,
      );

      // Companion Memory connect/disconnect sits just before Open.
      if (memoryButton) buttons.push(memoryButton);

      // Open button area for running apps with a GUI
      const openArea = renderOpenButtonArea();
      if (openArea) buttons.push(openArea);

      if (updateAvailable && !versionIsIgnored) {
        secondaryActions.push(
          <IconActionButton
            key="update"
            icon={Download}
            label={t('COMMON_UPDATE')}
            onClick={() => navigate(`${location.pathname}/update`, { state: { from: location.pathname } })}
          />,
          <IconActionButton
            key="ignore-version"
            icon={Ban}
            label={t('APP_ACTION_IGNORE_VERSION')}
            onClick={() => ignoreVersionMutation.mutate({ path: { urn: info.urn } })}
            disabled={ignoreVersionMutation.isPending}
          />,
        );
      } else if (versionIsIgnored) {
        secondaryActions.push(
          <IconActionButton
            key="unignore-version"
            icon={CheckCircle}
            label={t('APP_ACTION_UNIGNORE_VERSION')}
            onClick={() => unignoreVersionMutation.mutate({ path: { urn: info.urn } })}
            disabled={unignoreVersionMutation.isPending}
          />,
        );
      }
      if (runtimeHealth?.forceStopEligible) {
        secondaryActions.push(
          <IconActionButton
            key="force-stop"
            icon={AlertTriangle}
            label={t('APP_FORCE_STOP_ACTION')}
            onClick={forceStopDisclosure.open}
            className="text-destructive hover:text-destructive"
          />,
        );
      }
      break;
    }
    case 'installing':
      // Real backend cancel: aborts the in-progress install (kills the image pull / compose up) and
      // removes the partially-installed app. Confirmed via CancelInstallDialog since it discards the
      // partial install. Only offered for installs in Phase 1 — see the other transient statuses below.
      buttons.push(LoadingButton);
      secondaryActions.push(
        <IconActionButton
          key="cancel"
          icon={CircleStop}
          label={t('COMMON_CANCEL')}
          onClick={cancelInstallDisclosure.open}
          disabled={isCancellingInstall}
        />,
      );
      break;
    case 'uninstalling':
    case 'starting':
    case 'stopping':
    case 'restarting':
    case 'updating':
    case 'resetting':
    case 'backing_up':
    case 'restoring':
      // Short-lived transitions on an already-installed app. There is no way to cancel
      // them, and the only available action (uninstall) would destroy the app + data,
      // so show just the disabled progress button until the operation completes.
      buttons.push(LoadingButton);
      secondaryActions.push(
        <IconActionButton key="stop" icon={Pause} label={t('COMMON_STOP')} disabled />,
        <IconActionButton key="restart" icon={RotateCw} label={t('COMMON_RESTART')} disabled />,
      );
      break;
    case 'install_failed':
      buttons.push(RetryInstallButton);
      secondaryActions.push(
        <IconActionButton key="settings" icon={Settings} label={t('COMMON_SETTINGS')} onClick={updateSettingsDisclosure.open} />,
        <IconActionButton
          key="remove"
          icon={Trash}
          label={t('COMMON_REMOVE')}
          onClick={uninstallDisclosure.open}
          className="text-destructive hover:text-destructive"
        />,
      );
      break;
    default:
      if (info.urn.split(':')[1] === '_user') {
        secondaryActions.push(
          <IconActionButton
            key="edit-config"
            icon={Edit}
            label={t('CUSTOM_APP_EDIT_CONFIG')}
            onClick={() => navigate(`/apps/${info.id}/edit`)}
            disabled={app?.status !== 'stopped' && app?.status !== 'missing'}
          />,
        );
      }
      break;
  }

  return (
    <>
      <InstallDialog isOpen={installDisclosure.isOpen} onClose={installDisclosure.close} info={info} boundCustomDomain={app?.customDomain ?? null} />
      <CancelInstallDialog
        isOpen={cancelInstallDisclosure.isOpen}
        onClose={cancelInstallDisclosure.close}
        info={info}
        onCancelStart={() => setIsCancellingInstall(true)}
      />
      <StopDialog isOpen={stopDisclosure.isOpen} onClose={stopDisclosure.close} info={info} />
      <ForceStopDialog isOpen={forceStopDisclosure.isOpen} onClose={forceStopDisclosure.close} info={info} />
      <RestartDialog isOpen={restartDisclosure.isOpen} onClose={restartDisclosure.close} info={info} />
      <UninstallDialog isOpen={uninstallDisclosure.isOpen} onClose={uninstallDisclosure.close} info={info} />
      <ResetDialog isOpen={resetAppDisclosure.isOpen} onClose={resetAppDisclosure.close} info={info} />
      <DisconnectMemoryDialog
        isOpen={disconnectMemoryDisclosure.isOpen}
        onClose={disconnectMemoryDisclosure.close}
        info={info}
        onConfirm={memory.disconnect}
        isDisconnecting={memory.isDisconnecting}
      />
      <AppDataFolderDialog isOpen={appDataFolderDisclosure.isOpen} onClose={appDataFolderDisclosure.close} info={info} />
      <UpdateSettingsDialog
        isOpen={updateSettingsDisclosure.isOpen}
        onClose={updateSettingsDisclosure.close}
        info={info}
        config={{
          ...(app?.config ?? {}),
          /*
           * The row wins for this one field. `config` is the form snapshot as
           * it was last saved; `customDomainIntent` is the live choice, which the
           * Hub clears on its own when the domain stops being connected or is
           * picked for another app. Seeding from the snapshot would re-submit a
           * choice that has since been dropped — taking the domain off whatever
           * app holds it now, on a save the person thought changed nothing else.
           *
           * Falling back to the DELIVERED binding, because an app can be served on
           * a domain it never asked for here — one an operator bound in the portal,
           * or one whose intent the Hub has since cleared while Companion Portal keeps
           * serving it. Showing "use the platform address" for an app the browser
           * reaches at `comfy.acme.com` is a flat lie about where it lives, and the
           * save that follows sends `''` — the explicit instruction to give it up.
           */
          ...(app ? { customDomain: app.customDomainIntent ?? app.customDomain ?? '' } : {}),
          /*
           * The row wins here too, and it is the ONLY source. The confirmation
           * authorizes one move and the bind pass spends it, so the row is the
           * only thing that knows whether one is still outstanding —
           * `toStoredConfig` deliberately keeps it out of the snapshot so a spent
           * answer cannot come back as standing permission.
           *
           * Seeded rather than defaulted to `false` so an unrelated save does not
           * quietly withdraw a move the operator confirmed and the pass has not
           * reached yet.
           */
          ...(app ? { customDomainTakeover: app.customDomainTakeover ?? false } : {}),
          // From the row, like the takeover above: the stored config snapshot leaves
          // this setting out so that flipping it never restarts the app.
          ...(app ? { autoRestartOnDomainChange: app.autoRestartOnDomainChange ?? false } : {}),
          /*
           * What the operator is being SHOWN this app is served on, carried so the
           * save can be refused if it stops being true (R2-HUBDOMAINS-3).
           *
           * The BINDING, not the intent: `customDomain: ''` acts on what CI-Cloud
           * is actually serving, so that is the value the release has to be
           * conditioned on. A domain bound in the Portal while this dialog sat
           * open used to be released by the seeded `''` above — a save that never
           * mentioned the domain, taking a customer hostname off the air with a
           * success toast.
           */
          ...(app ? { customDomainExpected: app.customDomain ?? '' } : {}),
        }}
        status={app?.status}
      />
      <div className={clsx('space-y-1', layout === 'default' && 'mt-1')}>
        <div className={clsx('flex flex-wrap items-start gap-2', layout === 'hero' && 'hero-actions-layout')}>
          {layout === 'hero' ? InstallErrorMessage : null}
          {secondaryActions.length > 0 ? <div className="hero-action-bar">{secondaryActions}</div> : null}
          {buttons.map((button) => {
            return createElement(button.type, {
              ...button.props,
              key: button.key,
            });
          })}
        </div>
        {layout === 'hero' ? null : InstallErrorMessage}
      </div>
      <Tooltip id="app-actions-tooltip" className="tooltip" positionStrategy="fixed" />
    </>
  );
};
