import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconDots,
  IconDownload,
  IconEdit,
  IconEraser,
  IconExternalLink,
  IconPlayerPause,
  IconPlayerPlay,
  IconRotateClockwise,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';
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
import { Tooltip } from 'react-tooltip';
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
  IconComponent?: typeof IconDownload;
}

const ActionButton: React.FC<BtnProps> = (props) => {
  const { IconComponent, loading, title, className, ...rest } = props;

  const testId = loading ? 'action-button-loading' : undefined;

  return (
    <Button data-testid={testId} loading={loading} {...rest} className={clsx('action-button', className)}>
      {title}
      {IconComponent && <IconComponent className="ms-1" size={14} />}
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
      IconComponent={IconPlayerPlay}
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
        loading
        intent="success"
        title={`${t('APP_ACTION_LOADING')}${progressText}`}
        className="installation-progress-button"
      />
    );
  })();

  const RemoveListItem = (
    <DropdownMenuItem onClick={uninstallDisclosure.open} key="remove" className="text-danger">
      <IconTrash className="me-2" size={16} />
      {t('APP_ACTION_REMOVE')}
    </DropdownMenuItem>
  );
  const SettingsListItem = (
    <DropdownMenuItem onClick={updateSettingsDisclosure.open} key="settings">
      <IconSettings className="me-2" size={16} />
      {t('APP_ACTION_SETTINGS')}
    </DropdownMenuItem>
  );
  const RestartListItem = (
    <DropdownMenuItem onClick={restartDisclosure.open} key="restart" className="configChanged">
      <IconRotateClockwise className="me-2" size={16} />
      {t('APP_ACTION_RESTART')}
      {app?.pendingRestart && (
        <div>
          <Tooltip className="tooltip" anchorSelect=".configChanged">
            {t('MY_APPS_PENDING_RESTART')}
          </Tooltip>
          <span className="ms-2 badge bg-red" />
        </div>
      )}
    </DropdownMenuItem>
  );
  const UpdateListItem = (
    <DropdownMenuItem
      onClick={() => navigate(`${location.pathname}/update`, { state: { from: location.pathname } })}
      key="update"
      className="updateAvailable"
    >
      <IconDownload className="me-2" size={16} />
      <Tooltip className="tooltip" anchorSelect=".updateAvailable">
        {t('MY_APPS_UPDATE_AVAILABLE')}
      </Tooltip>
      <div>
        {t('APP_ACTION_UPDATE')}
        <span className="ms-2 badge bg-red" />
      </div>
    </DropdownMenuItem>
  );
  const IgnoreVersionListItem = (
    <DropdownMenuItem
      onClick={() => ignoreVersionMutation.mutate({ path: { urn: info.urn } })}
      key="ignore-version"
      disabled={ignoreVersionMutation.isPending}
    >
      <IconBan className="me-2" size={16} />
      {t('APP_ACTION_IGNORE_VERSION')}
    </DropdownMenuItem>
  );
  const UnignoreVersionListItem = (
    <DropdownMenuItem
      onClick={() => unignoreVersionMutation.mutate({ path: { urn: info.urn } })}
      key="unignore-version"
      disabled={unignoreVersionMutation.isPending}
    >
      <IconCircleCheck className="me-2" size={16} />
      {t('APP_ACTION_UNIGNORE_VERSION')}
    </DropdownMenuItem>
  );
  const CancelListItem = (
    <DropdownMenuItem onClick={stopDisclosure.open} key="cancel">
      <IconPlayerPause className="me-2" size={16} />
      {t('APP_ACTION_CANCEL')}
    </DropdownMenuItem>
  );
  const ResetListItem = (
    <DropdownMenuItem onClick={resetAppDisclosure.open} key="reset" className="text-danger">
      <IconEraser className="me-2" size={16} />
      {t('APP_INSTALL_FORM_RESET')}
    </DropdownMenuItem>
  );

  const EditConfigListItem = (
    <DropdownMenuItem
      onClick={() => navigate(`/apps/${info.id}/edit`)}
      key="edit-config"
      disabled={app?.status !== 'stopped' && app?.status !== 'missing'}
    >
      <IconEdit className="me-2" size={16} />
      {t('CUSTOM_APP_EDIT_CONFIG')}
    </DropdownMenuItem>
  );

  const StopButton = (
    <ActionButton key="stop" IconComponent={IconPlayerPause} onClick={stopDisclosure.open} title={t('APP_ACTION_STOP')} intent="default" />
  );
  const InstallButton = <ActionButton key="install" onClick={installDisclosure.open} title={t('APP_ACTION_INSTALL')} intent="success" />;

  // Check if the app URL is available before showing Open button
  const [checkError, setCheckError] = useState<string | null>(null);
  const [urlAvailable, setUrlAvailable] = useState<boolean | null>(null);
  const [isCheckingUrl, setIsCheckingUrl] = useState(false);

  const subdomain = app?.localSubdomain;
  const organizationSlug = userSettings.ciHubOrganizationSlug;
  const domainSuffix = `-${organizationSlug}.${userSettings.domain}`;
  const appUrl = `https://${subdomain}${domainSuffix}${info.url_suffix || ''}`;

  useEffect(() => {
    // Only check if app is running and exposed
    if (app?.status === 'running' && (app?.exposedLocal || app?.openPort || app?.exposed) && !info.no_gui) {
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
          const { available, reason } = (data || {}) as { available: boolean; reason?: 'CLOUDFLARE' | 'APP_ERROR' };

          if (isMounted) {
            setUrlAvailable(available);

            if (available) {
              setIsCheckingUrl(false);
              setCheckError(null);
              // If available, stop polling
              isAvailableRef = true;
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
            } else {
              // Page resolves but errors (e.g. Cloudflare error)
              setIsCheckingUrl(false); // Stop spinner to show error button
              setCheckError(reason === 'CLOUDFLARE' ? 'Cloudflare Error' : 'Application Error');
            }
          }
        } catch (error) {
          // If check request fails (e.g. CORS or network error/DNS not found), keep loading (DNS propagating)
          if (isMounted) {
            setUrlAvailable(null);
            setIsCheckingUrl(true);
            setCheckError(error instanceof Error ? error.message : 'Unknown error');
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
  }, [app?.status, app?.exposedLocal, app?.openPort, app?.exposed, info.no_gui, info.urn]);

  const OpenButton = (
    <ActionButton
      key="open"
      IconComponent={IconExternalLink}
      onClick={() => {
        // Open the app in a new tab
        window.open(appUrl, '_blank');
      }}
      title={t('APP_ACTION_OPEN')}
      disabled={isCheckingUrl || urlAvailable === false}
      loading={isCheckingUrl}
    />
  );

  const ErrorButton = (
    <div key="error">
      <ActionButton IconComponent={IconAlertTriangle} title={t('APP_ACTION_OPEN')} className="app-error-button" intent="danger" disabled />
      <Tooltip className="tooltip" anchorSelect=".app-error-button">
        {checkError}
      </Tooltip>
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

      // Show Open button if app is exposed (will be disabled while checking availability)
      if (!info.no_gui && (app?.exposedLocal || app?.openPort || app?.exposed)) {
        if (checkError) {
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
      />
      <div className="mt-1 btn-list d-flex">
        {buttons.map((button) => {
          return createElement(button.type, {
            ...button.props,
            key: button.key,
          });
        })}
        {listItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button name="more" className="more-button">
                <IconDots size={14} />
                {((updateAvailable && !versionIsIgnored) || app?.pendingRestart) && <span className="badge badge-dot bg-red badge-notification" />}
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
