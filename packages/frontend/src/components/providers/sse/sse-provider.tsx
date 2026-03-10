import { useSSE } from '@/lib/hooks/use-sse';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@runtipi/common/types';
import { useQueryClient } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { updateInstallationProgress } from '@/modules/app/helpers/use-installation-progress';

export const SSEProvider = ({ children }: PropsWithChildren) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useSSE({
    topic: 'app',
    onEvent: (data) => {
      const { event, appUrn, error, appStatus } = data;
      // Type guard: progress is only available on status_change events
      const progress = 'progress' in data ? data.progress : undefined;

      if (error) {
        console.error(error);
      }

      const { appName, appStoreId } = extractAppUrn(appUrn as AppUrn);

      // Invalidate queries to refresh app data (including progress)
      queryClient.invalidateQueries();

      // Persist install errors in the query cache so UI components can render them
      // under the app action button. Clear the cached error when status changes
      // indicate install success/failure or when installation restarts.
      try {
        if (event === 'install_error' && appUrn && error) {
          queryClient.setQueryData(['app-install-error', appUrn], { message: error, ts: Date.now() });
        }

        if (event === 'install_success') {
          queryClient.setQueryData(['app-install-error', appUrn], null);
        }

        if (event === 'status_change' && (appStatus === 'running' || appStatus === 'missing' || appStatus === 'installing')) {
          queryClient.setQueryData(['app-install-error', appUrn], null);
        }
      } catch (e) {
        // Non-fatal: cache manipulation should not break SSE handling
        // eslint-disable-next-line no-console
        console.error('Failed to update app-install-error cache', e);
      }

      if (appStoreId === '_user' && event === 'uninstall_success') {
        navigate('/apps', { replace: true });
      }

      switch (event) {
        case 'status_change':
          // Update installation progress when app is installing
          if (appStatus === 'installing' && typeof progress === 'number') {
            updateInstallationProgress(appUrn as AppUrn, progress);
          } else if (appStatus === 'running' || appStatus === 'missing') {
            // Clear progress when installation completes or fails
            updateInstallationProgress(appUrn as AppUrn, null);
          }
          break;
        case 'install_success':
          // Clear progress when installation completes
          updateInstallationProgress(appUrn as AppUrn, null);
          toast.success(t('APP_INSTALL_SUCCESS', { id: appName }));
          break;
        case 'install_error':
          // Clear progress when installation fails
          updateInstallationProgress(appUrn as AppUrn, null);
          toast.error(t('APP_ERROR_APP_FAILED_TO_INSTALL', { id: appName }));
          break;
        case 'start_success':
          toast.success(t('APP_START_SUCCESS', { id: appName }));
          break;
        case 'start_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_START', { id: appName }));
          break;
        case 'stop_success':
          toast.success(t('APP_STOP_SUCCESS', { id: appName }));
          break;
        case 'stop_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_STOP', { id: appName }));
          break;
        case 'uninstall_success':
          toast.success(t('APP_UNINSTALL_SUCCESS', { id: appName }));
          break;
        case 'uninstall_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_UNINSTALL', { id: appName }));
          break;
        case 'update_success':
          toast.success(t('APP_UPDATE_SUCCESS', { id: appName }));
          break;
        case 'update_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_UPDATE', { id: appName }));
          break;
        case 'reset_success':
          toast.success(t('APP_RESET_SUCCESS', { id: appName }));
          break;
        case 'reset_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_RESET', { id: appName }));
          break;
        case 'restart_success':
          toast.success(t('APP_RESTART_SUCCESS', { id: appName }));
          break;
        case 'restart_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_RESTART', { id: appName }));
          break;
        case 'backup_success':
          toast.success(t('APP_BACKUP_SUCCESS', { id: appName }));
          break;
        case 'backup_error':
          toast.error(t('APP_BACKUP_ERROR', { id: appName }));
          break;
        case 'restore_success':
          toast.success(t('APP_RESTORE_SUCCESS', { id: appName }));
          break;
        case 'restore_error':
          toast.error(t('APP_RESTORE_ERROR', { id: appName }));
          break;
        default:
          break;
      }
    },
  });

  return children;
};
