import { useSSE } from '@/lib/hooks/use-sse';
import { handleAppSseEvent, type AppSsePayload } from '@/modules/app/helpers/app-sse-cache';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@ci-hub/common/types';
import { useQueryClient } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

const logsPageHref = '/settings?tab=logs';

export const SSEProvider = ({ children }: PropsWithChildren) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useSSE({
    topic: 'app',
    onEvent: (data) => {
      const payload = data as AppSsePayload;
      const { event, appUrn, error } = payload;

      if (error) {
        console.error(error);
      }

      try {
        handleAppSseEvent(queryClient, payload);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Failed to update app cache from SSE', e);
      }

      if (event === 'install_queue') {
        return;
      }

      if (!appUrn) {
        return;
      }

      const { appName, appStoreId } = extractAppUrn(appUrn as AppUrn);

      if (appStoreId === '_user' && event === 'uninstall_success') {
        navigate('/store', { replace: true });
      }

      switch (event) {
        case 'install_success':
          toast.success(t('APP_INSTALL_SUCCESS', { id: appName }));
          break;
        case 'install_error':
          toast.error((toastInstance) => (
            <span className="text-sm">
              <Trans
                i18nKey="APP_ERROR_APP_FAILED_TO_INSTALL_TOAST"
                values={{ id: appName, logsLabel: t('COMMON_LOGS') }}
                components={{
                  logsLink: <Link to={logsPageHref} className="font-medium underline" onClick={() => toast.dismiss(toastInstance.id)} />,
                }}
              />
            </span>
          ));
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
        case 'public_dns_error':
          toast.error(t('APP_ERROR_PUBLIC_DNS_FAILED', { id: appName }));
          break;
        default:
          break;
      }
    },
  });

  return children;
};
