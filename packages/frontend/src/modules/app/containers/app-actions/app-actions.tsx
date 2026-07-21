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
import { createElement, useState, useEffect, useRef } from 'react';
import { client } from '@/api-client/client.gen';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import './app-actions.css';
import { ignoreAppVersionMutation, startAppMutation, unignoreAppVersionMutation } from '@/api-client/@tanstack/react-query.gen';
import type { AppDetails, AppInfo, AppMetadata, AppStatus } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import clsx from 'clsx';
import { Tooltip } from 'react-tooltip';
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
import type { AppInstallErrorCache } from '../../helpers/app-sse-cache';
import type { AppUrn } from '@ci-hub/common/types';
import { openExternal } from '@/lib/helpers/open-external';
import { openPathInFileExplorer } from '@/lib/helpers/open-folder';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { openExternalWithHubSession } from '@/lib/hub-browser-handoff';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { clearStashedInstallIntentForApp, resolvePendingInstallIntent, shouldAutoOpenInstall } from '@/lib/deep-link-install';
import type { AppUrlAvailability } from '../../helpers/use-app-url-availability';

interface IProps {
  app?: AppDetails | null;
  info: AppInfo;
  metadata: AppMetadata;
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
      {IconComponent && (
        // Provide accessible name for icons (assistive tech will read the button label as well)
        <IconComponent className="ml-1" size={14} role="img" aria-label={title?.toString() ?? undefined} />
      )}
    </Button>
  );
};

const IconActionButton: React.FC<IconBtnProps> = ({ icon: Icon, label, className, ...props }) => (
  <Button
    type="button"
    size="icon"
    variant="ghost"
    aria-label={label}
    title={label}
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

  // Local optimistic flag while a cancel is in flight: the backend keeps the app in `installing`
  // until compensation finishes and the `install_cancelled` SSE lands, so we surface "Cancelling…".
  const [isCancellingInstall, setIsCancellingInstall] = useState(false);

  const { t } = useTranslation();
  const { setOptimisticStatus } = useAppStatus();
  const installationProgress = useInstallationProgress(app?.status === 'installing' ? (info.urn as AppUrn) : undefined);
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const autoInstallTriggeredRef = useRef(false);
  const memory = useMemoryConnection(info.urn);

  // Opening an app hands the flow to the system browser, which (in the desktop app)
  // holds no Hub session cookie. Only a memory-consumer app matters here: its
  // interstitial navigates to the Hub origin and would otherwise demand a second Hub
  // login, so bridge the desktop session into that browser first. Every other app
  // opens directly — no reason to route them through a Hub round-trip. The bridge
  // fails open, so an unavailable handoff never blocks the open.
  const openExternalUrl = (url: string) => (memory.applicable ? openExternalWithHubSession(url) : openExternal(url));

  // Clear the optimistic "cancelling" flag once the app leaves the installing state (the
  // install_cancelled SSE flips it to uninstalled/missing), so a later re-install isn't affected.
  useEffect(() => {
    if (app?.status !== 'installing') {
      setIsCancellingInstall(false);
    }
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

    autoInstallTriggeredRef.current = true;
    installDisclosure.open();
    clearStashedInstallIntentForApp(appSlug, storeId);

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
  }, [app?.status, appSlug, storeId, location.pathname, location.search, navigate, searchParams, installDisclosure.open]);

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
      installDisclosure.open();
      clearStashedInstallIntentForApp(appSlug, storeId);
    })();
  }, [app?.status, appSlug, storeId, installDisclosure.open]);

  const versionIsIgnored = app?.ignoredVersion === metadata.latestVersion;
  const updateAvailable = Number(app?.version ?? 0) < Number(metadata?.latestVersion || 0);

  const startMutation = useMutation({
    ...startAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
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
    const progressValue = progress === null ? 12 : Math.max(8, Math.min(99, progress));

    const cancelling = isCancellingInstall && app?.status === 'installing';
    const statusLabel = cancelling ? t('APP_STATUS_CANCELLING') : t((app?.status && LOADING_STATUS_LABEL_KEYS[app.status]) ?? 'COMMON_INSTALLING');

    let stageText = t('APP_ACTION_PREPARING');
    if (cancelling) {
      stageText = t('APP_STATUS_CANCELLING');
    } else if (progress !== null) {
      if (progress >= INSTALL_FINALIZING_PROGRESS) stageText = t('APP_ACTION_FINALIZING');
      else if (progress >= 60) stageText = t('APP_ACTION_DOWNLOADING');
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
          aria-valuenow={progress ?? undefined}
          aria-valuetext={stageText}
        >
          <div className="installation-progress-fill" style={{ width: `${progressValue}%` }} />
        </div>
        <p className="installation-progress-stage">{stageText}</p>
      </div>
    );
  })();

  const InstallButton = (
    <ActionButton
      key="install"
      onClick={installDisclosure.open}
      title={t('COMMON_INSTALL')}
      variant="default"
      size="lg"
      className="install-action-button"
    />
  );
  const RetryInstallButton = (
    <ActionButton
      key="retry-install"
      IconComponent={RotateCw}
      onClick={installDisclosure.open}
      title={t('APP_ACTION_RETRY_INSTALL')}
      variant="outline"
      size="lg"
      className="retry-install-action-button"
    />
  );

  // Local-mode apps skip the availability probe entirely (their LAN address is
  // reachable the moment the container binds), so this page fetches the URL on
  // demand the first time Open is clicked and caches it here.
  const [localAppUrl, setLocalAppUrl] = useState<string | null>(null);

  // Show install errors surfaced from SSE via query cache
  const queryClient = useQueryClient();
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
  const { state: publicUrlState, statusMessage, withinGracePeriod, pollingStopped, resolvable, isResolving } = urlAvailability;
  const appUrl = urlAvailability.appUrl ?? localAppUrl;

  // Build the Open button area for running apps with GUI
  const renderOpenButtonArea = () => {
    if (info.no_gui) return null;

    // Local mode: always show enabled Open button immediately
    if (isLocal) {
      return (
        <ActionButton
          key="open-local"
          IconComponent={ExternalLink}
          onClick={() => {
            // For local, construct URL from app data since backend returns it immediately
            if (appUrl) {
              openExternalUrl(appUrl);
            } else {
              // Fetch URL on-demand for local
              client
                .get({ url: `/api/apps/${info.urn}/check-availability` })
                .then(({ data }) => {
                  const result = (data || {}) as { appUrl?: string };
                  if (result.appUrl) {
                    setLocalAppUrl(result.appUrl);
                    openExternalUrl(result.appUrl);
                  }
                })
                .catch(() => {
                  // A transient backend/tunnel failure (e.g. a Cloudflare 530
                  // while the tunnel reconnects) must not become an unhandled
                  // rejection surfaced as a generic error. Tell the user instead.
                  toast.error(t('APP_ACTION_COULD_NOT_REACH_HUB'));
                });
            }
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
    // once we've stopped probing on our own.
    if ((publicUrlState === 'propagating' || publicUrlState === 'unreachable') && resolvable) {
      return (
        <div key="open-resolvable" className="flex flex-col items-start gap-1">
          {pollingStopped ? (
            <ActionButton IconComponent={RotateCw} title={t('COMMON_RETRY')} intent="warning" onClick={urlAvailability.reset} />
          ) : (
            <ActionButton
              IconComponent={RotateCw}
              title={t('APP_ACTION_RESOLVE')}
              intent="warning"
              onClick={urlAvailability.resolve}
              loading={isResolving}
              disabled={isResolving}
            />
          )}
          {statusMessage && <span className="text-xs text-amber-600">{statusMessage}</span>}
          {openAnywayLink}
        </div>
      );
    }

    // Settled failure with nothing the Hub can do about it.
    if (publicUrlState === 'unreachable') {
      return (
        <div key="open-error" className="flex flex-col items-start gap-1">
          <ActionButton IconComponent={AlertTriangle} title={t('APP_ACTION_OPEN')} intent="danger" disabled />
          {statusMessage && <span className="text-xs text-destructive">{statusMessage}</span>}
          {openAnywayLink}
        </div>
      );
    }

    // Fallback: still checking. Same full-size footprint as the enabled Open
    // button so the spinner state doesn't render smaller.
    return <ActionButton key="open-checking" title={t('APP_ACTION_OPEN')} disabled loading size="lg" className="launch-action-button" />;
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

  // "Open data folder" is a desktop-only native action: it needs the Tauri
  // runtime and a backend-resolved host path. Hidden in the web client.
  const openDataFolderButton =
    getTauriInvoke() && appDataHostPath ? (
      <IconActionButton
        key="open-data-folder"
        icon={FolderOpen}
        label={t('APP_ACTION_OPEN_DATA_FOLDER')}
        onClick={() => openPathInFileExplorer(appDataHostPath)}
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

    if (memory.memoryReady) {
      return (
        <ActionButton
          key="memory-connect"
          IconComponent={BrainCircuit}
          title={t('MEMORY_CONNECT_ACTION_CONNECT_MEMORY')}
          onClick={memory.connect}
          disabled={!memory.connectUrl}
          variant="outline"
          size="lg"
          className="launch-action-button memory-action-button"
          data-tooltip-id="app-actions-tooltip"
          data-tooltip-content={t('MEMORY_CONNECT_DESC')}
        />
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
    case 'missing':
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
      <InstallDialog isOpen={installDisclosure.isOpen} onClose={installDisclosure.close} info={info} />
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
      <UpdateSettingsDialog
        isOpen={updateSettingsDisclosure.isOpen}
        onClose={updateSettingsDisclosure.close}
        info={info}
        config={app?.config ?? {}}
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
        <Tooltip id="app-actions-tooltip" className="tooltip" />
        {layout === 'hero' ? null : InstallErrorMessage}
      </div>
    </>
  );
};
