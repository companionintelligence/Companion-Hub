import {
  AlertTriangle,
  Ban,
  CheckCircle,
  MoreHorizontal,
  Download,
  Edit,
  Eraser,
  ExternalLink,
  Pause,
  Play,
  RotateCw,
  Settings,
  Trash,
} from 'lucide-react';
import type React from 'react';
import { createElement, useState, useEffect } from 'react';
import { client } from '@/api-client/client.gen';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import './app-actions.css';
import { ignoreAppVersionMutation, startAppMutation, unignoreAppVersionMutation } from '@/api-client/@tanstack/react-query.gen';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { InstallDialog } from '../../components/dialogs/install-dialog/install-dialog';
import { ResetDialog } from '../../components/dialogs/reset-dialog/reset-dialog';
import { RestartDialog } from '../../components/dialogs/restart-dialog/restart-dialog';
import { StopDialog } from '../../components/dialogs/stop-dialog/stop-dialog';
import { UninstallDialog } from '../../components/dialogs/uninstall-dialog/uninstall-dialog';
import { UpdateSettingsDialog } from '../../components/dialogs/update-settings-dialog/update-settings-dialog';
import { useAppStatus } from '../../helpers/use-app-status';
import { useInstallationProgress } from '../../helpers/use-installation-progress';
import { DropdownMenuSeparator } from '@/components/ui/DropdownMenu/DropdownMenu';
import { useLocation, useNavigate } from 'react-router';
import type { AppUrn } from '@runtipi/common/types';
import { useAppContext } from '@/context/app-context';

interface IProps {
  app?: AppDetails | null;
  info: AppInfo;
  metadata: AppMetadata;
  localDomain?: string;
  sslPort?: number;
}

interface BtnProps extends ButtonProps {
  IconComponent?: typeof Download;
}

const ActionButton: React.FC<BtnProps> = (props) => {
  const { IconComponent, loading, title, className, ...rest } = props;

  // Generate testId from title (e.g., "Start" -> "action-start", "Install" -> "action-install")
  const actionName = title?.toString().toLowerCase().replace(/\s+/g, '-') || 'unknown';
  const testId = loading ? 'action-button-loading' : `action-${actionName}`;

  return (
    <Button data-testid={testId} loading={loading} {...rest} className={clsx('action-button', className)}>
      {title}
      {IconComponent && <IconComponent className="ml-1" size={14} />}
    </Button>
  );
};

export const AppActions = ({ app, info, metadata }: IProps) => {
  const { userSettings } = useAppContext();
  const installDisclosure = useDisclosure();
  const stopDisclosure = useDisclosure();
  const restartDisclosure = useDisclosure();
  const updateSettingsDisclosure = useDisclosure();
  const uninstallDisclosure = useDisclosure();
  const resetAppDisclosure = useDisclosure();

  const { t } = useTranslation();
  const { setOptimisticStatus } = useAppStatus();
  const installationProgress = useInstallationProgress(app?.status === 'installing' ? (info.urn as AppUrn) : undefined);
  const location = useLocation();
  const navigate = useNavigate();

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
      intent="success"
    />
  );
  const LoadingButton = (() => {
    const progress = app?.status === 'installing' ? installationProgress : null;
    const progressText = progress !== null ? ` ${progress}%` : '';
    return (
      <ActionButton
        key="loading"
        // Show installing text and make button disabled while in-progress
        disabled
        intent="success"
        title={`${t('APP_ACTION_INSTALLING')}${progressText}`}
        className="installation-progress-button"
      />
    );
  })();

  const RemoveListItem = (
    <DropdownMenuItem onClick={uninstallDisclosure.open} key="remove" className="text-destructive focus:text-destructive">
      <Trash className="mr-2" size={16} />
      {t('APP_ACTION_REMOVE')}
    </DropdownMenuItem>
  );
  const SettingsListItem = (
    <DropdownMenuItem onClick={updateSettingsDisclosure.open} key="settings">
      <Settings className="mr-2" size={16} />
      {t('APP_ACTION_SETTINGS')}
    </DropdownMenuItem>
  );
  const RestartListItem = (
    <DropdownMenuItem onClick={restartDisclosure.open} key="restart">
      <RotateCw className="mr-2" size={16} />
      {t('APP_ACTION_RESTART')}
      {app?.pendingRestart && <span className="ml-2 h-2 w-2 rounded-full bg-red-500" />}
    </DropdownMenuItem>
  );
  const UpdateListItem = (
    <DropdownMenuItem onClick={() => navigate(`${location.pathname}/update`, { state: { from: location.pathname } })} key="update">
      <Download className="mr-2" size={16} />
      {t('APP_ACTION_UPDATE')}
      <span className="ml-2 h-2 w-2 rounded-full bg-red-500" />
    </DropdownMenuItem>
  );
  const IgnoreVersionListItem = (
    <DropdownMenuItem
      onClick={() => ignoreVersionMutation.mutate({ path: { urn: info.urn } })}
      key="ignore-version"
      disabled={ignoreVersionMutation.isPending}
    >
      <Ban className="mr-2" size={16} />
      {t('APP_ACTION_IGNORE_VERSION')}
    </DropdownMenuItem>
  );
  const UnignoreVersionListItem = (
    <DropdownMenuItem
      onClick={() => unignoreVersionMutation.mutate({ path: { urn: info.urn } })}
      key="unignore-version"
      disabled={unignoreVersionMutation.isPending}
    >
      <CheckCircle className="mr-2" size={16} />
      {t('APP_ACTION_UNIGNORE_VERSION')}
    </DropdownMenuItem>
  );
  const CancelListItem = (
    // During installation we want the cancel option to surface the uninstall flow
    // which will remove the partially installed app. Reuse the uninstall dialog.
    <DropdownMenuItem onClick={uninstallDisclosure.open} key="cancel">
      <Pause className="mr-2" size={16} />
      {t('APP_ACTION_CANCEL')}
    </DropdownMenuItem>
  );
  const ResetListItem = (
    <DropdownMenuItem onClick={resetAppDisclosure.open} key="reset" className="text-destructive focus:text-destructive">
      <Eraser className="mr-2" size={16} />
      {t('APP_INSTALL_FORM_RESET')}
    </DropdownMenuItem>
  );

  const EditConfigListItem = (
    <DropdownMenuItem
      onClick={() => navigate(`/apps/${info.id}/edit`)}
      key="edit-config"
      disabled={app?.status !== 'stopped' && app?.status !== 'missing'}
    >
      <Edit className="mr-2" size={16} />
      {t('CUSTOM_APP_EDIT_CONFIG')}
    </DropdownMenuItem>
  );

  const StopButton = <ActionButton key="stop" IconComponent={Pause} onClick={stopDisclosure.open} title={t('APP_ACTION_STOP')} intent="default" />;
  const InstallButton = <ActionButton key="install" onClick={installDisclosure.open} title={t('APP_ACTION_INSTALL')} intent="success" />;

  // Check if the app URL is available before showing Open button
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkErrorCode, setCheckErrorCode] = useState<string | null>(null);
  const [errorResolvable, setErrorResolvable] = useState(false);
  const [urlAvailable, setUrlAvailable] = useState<boolean | null>(null);
  const [isCheckingUrl, setIsCheckingUrl] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [appUrl, setAppUrl] = useState<string | null>(null);

  // Fallback URL construction (used before backend responds)
  const subdomain = app?.localSubdomain;
  const organizationSlug = userSettings.ciHubOrganizationSlug;
  const domainSuffix = `-${organizationSlug}.${userSettings.domain}`;
  const fallbackUrl = `https://${subdomain}${domainSuffix}${info.url_suffix || ''}`;

  const triggerRecheck = () => {
    setUrlAvailable(null);
    setCheckError(null);
    setCheckErrorCode(null);
    setErrorResolvable(false);
    setIsCheckingUrl(true);
  };

  const handleResolve = async () => {
    setIsResolving(true);
    try {
      const { data } = await client.post({ url: `/api/apps/${info.urn}/resolve-availability` });
      const result = (data || {}) as { success: boolean; detail: string };
      if (result.success) {
        toast.success(result.detail || 'Resolution attempted. Rechecking...');
        // Wait a moment for changes to take effect, then recheck
        setTimeout(triggerRecheck, 3000);
      } else {
        toast.error(result.detail || 'Resolution failed.');
      }
    } catch (e) {
      toast.error(`Failed to resolve: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setIsResolving(false);
    }
  };

  useEffect(() => {
    // Only check if app is running and exposed
    if (app?.status === 'running' && !info.no_gui) {
      setIsCheckingUrl(true);
      setUrlAvailable(null);

      let isMounted = true;
      let isAvailableRef = false; // Track availability to stop polling
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      // Check if URL is reachable directly from client
      const checkUrl = async () => {
        if (!isMounted || isAvailableRef) return;

        try {
          const { data } = await client.get({ url: `/api/apps/${info.urn}/check-availability` });
          const {
            available,
            appUrl: resolvedUrl,
            detail,
            resolvable,
            errorCode,
          } = (data || {}) as {
            available: boolean;
            appUrl?: string;
            reason?: string;
            detail?: string;
            errorCode?: string;
            resolvable?: boolean;
          };

          if (isMounted) {
            if (resolvedUrl) {
              setAppUrl(resolvedUrl);
            }
            setUrlAvailable(available);

            if (available) {
              setIsCheckingUrl(false);
              setCheckError(null);
              setCheckErrorCode(null);
              setErrorResolvable(false);
              isAvailableRef = true;
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
            } else {
              setIsCheckingUrl(false);
              setCheckError(detail || 'Application Error');
              setCheckErrorCode(errorCode || null);
              setErrorResolvable(resolvable ?? false);
            }
          }
        } catch (error) {
          if (isMounted) {
            setUrlAvailable(null);
            setIsCheckingUrl(true);
            setCheckError(error instanceof Error ? error.message : 'Unknown error');
            setCheckErrorCode(null);
            setErrorResolvable(false);
          }
        }
      };

      // Initial check after short delay
      const initialTimeout = setTimeout(() => {
        checkUrl();

        // Start polling every 5 seconds until available
        pollInterval = setInterval(checkUrl, 5000);
      }, 1000);

      return () => {
        isMounted = false;
        clearTimeout(initialTimeout);
        if (pollInterval) {
          clearInterval(pollInterval);
        }
      };
    }
    setUrlAvailable(null);
    setIsCheckingUrl(false);
    setCheckError(null);
    setCheckErrorCode(null);
    setErrorResolvable(false);
  }, [app?.status, info.no_gui, info.urn]);

  const isTunnelPending = checkErrorCode === 'CF_UPSTREAM_ERROR' || checkErrorCode === 'CF_TUNNEL_NOT_FOUND';

  const OpenButton = (
    <ActionButton
      key="open"
      IconComponent={ExternalLink}
      onClick={() => {
        window.open(appUrl || fallbackUrl, '_blank');
      }}
      title={t('APP_ACTION_OPEN')}
      disabled={isCheckingUrl || urlAvailable === false}
      loading={isCheckingUrl}
    />
  );

  const PendingButton = <ActionButton key="pending" title={t('APP_ACTION_PENDING')} disabled loading />;

  const ErrorButton = errorResolvable ? (
    <div key="error" title={checkError ?? undefined}>
      <ActionButton
        IconComponent={RotateCw}
        title={t('APP_ACTION_RESOLVE')}
        intent="warning"
        onClick={handleResolve}
        loading={isResolving}
        disabled={isResolving}
      />
    </div>
  ) : (
    <div key="error" title={checkError ?? undefined}>
      <ActionButton IconComponent={AlertTriangle} title={t('APP_ACTION_OPEN')} intent="danger" disabled />
    </div>
  );

  const buttons: React.JSX.Element[] = [];
  const listItems: React.JSX.Element[] = [];
  const listItemsDestructive: React.JSX.Element[] = [];

  if (info.urn.split(':')[1] === '_user') {
    listItems.push(EditConfigListItem);
  }

  switch (app?.status ?? 'missing') {
    case 'stopped':
      buttons.push(StartButton);
      listItems.push(SettingsListItem);
      listItemsDestructive.push(ResetListItem);
      listItemsDestructive.push(RemoveListItem);
      if (updateAvailable && !versionIsIgnored) {
        listItems.push(UpdateListItem);
        listItems.push(IgnoreVersionListItem);
      } else if (versionIsIgnored) {
        listItems.push(UnignoreVersionListItem);
      }
      break;
    case 'running':
      buttons.push(StopButton);
      listItems.push(SettingsListItem);
      listItems.push(RestartListItem);
      listItemsDestructive.push(ResetListItem);
      listItemsDestructive.push(RemoveListItem);

      // Always show Open button for running apps with a GUI
      if (!info.no_gui) {
        if (checkError && isTunnelPending) {
          buttons.push(PendingButton);
        } else if (checkError) {
          buttons.push(ErrorButton);
        } else {
          buttons.push(OpenButton);
        }
      }

      if (updateAvailable && !versionIsIgnored) {
        listItems.push(UpdateListItem);
        listItems.push(IgnoreVersionListItem);
      } else if (versionIsIgnored) {
        listItems.push(UnignoreVersionListItem);
      }
      break;
    case 'installing':
    case 'uninstalling':
    case 'starting':
    case 'stopping':
    case 'restarting':
    case 'updating':
    case 'resetting':
    case 'backing_up':
    case 'restoring':
      buttons.push(LoadingButton);
      listItems.push(CancelListItem);
      break;
    case 'missing':
      buttons.push(InstallButton);
      if (info.urn.split(':')[1] === '_user') {
        listItemsDestructive.push(RemoveListItem);
      }
      break;
    default:
      break;
  }

  return (
    <>
      <InstallDialog isOpen={installDisclosure.isOpen} onClose={installDisclosure.close} info={info} />
      <StopDialog isOpen={stopDisclosure.isOpen} onClose={stopDisclosure.close} info={info} />
      <RestartDialog isOpen={restartDisclosure.isOpen} onClose={restartDisclosure.close} info={info} />
      <UninstallDialog isOpen={uninstallDisclosure.isOpen} onClose={uninstallDisclosure.close} info={info} />
      <ResetDialog isOpen={resetAppDisclosure.isOpen} onClose={resetAppDisclosure.close} info={info} />
      <UpdateSettingsDialog
        isOpen={updateSettingsDisclosure.isOpen}
        onClose={updateSettingsDisclosure.close}
        info={info}
        config={app?.config ?? {}}
        status={app?.status}
      />
      <div className="mt-1 flex flex-wrap gap-2">
        {buttons.map((button) => {
          return createElement(button.type, {
            ...button.props,
            key: button.key,
          });
        })}
        {listItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" name="more" className="more-button relative">
                <MoreHorizontal size={14} />
                {((updateAvailable && !versionIsIgnored) || app?.pendingRestart) && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-red-500" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>{listItems}</DropdownMenuGroup>
              {listItemsDestructive.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>{listItemsDestructive}</DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </>
  );
};
