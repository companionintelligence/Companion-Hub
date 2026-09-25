import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { useSSE } from '@/lib/hooks/use-sse';
import { applyHubHello } from '@/lib/hub-hello';
import { usesSameOriginHubApi } from '@/lib/hub-runtime-mode';
import { handleAppSseEvent, type AppSsePayload } from '@/modules/app/helpers/app-sse-cache';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@ci-hub/common/types';
import { useQueryClient } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { toast } from 'sonner';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

const logsPageHref = '/settings?tab=logs';

/**
 * Map Companion Portal's public-DNS failure class onto the message the user sees. An
 * unknown or absent code (older Companion Portal) falls back to the generic copy.
 *
 * The SSE event carries only the class, not the Portal's own message, so each class
 * gets translated copy here.
 */
const PUBLIC_DNS_ERROR_KEYS: Record<string, string> = {
  conflict: 'APP_ERROR_PUBLIC_DNS_CONFLICT',
  zone_unreachable: 'APP_ERROR_PUBLIC_DNS_ZONE_UNAVAILABLE',
  // A transient Cloudflare rejection is not a domain problem — the generic
  // fallback copy tells the user to check their domain, which is the very
  // misattribution this mapping exists to end.
  api_error: 'APP_ERROR_PUBLIC_DNS_TEMPORARY',
  // The subdomain is the problem, not the domain — pointing the user at the
  // domain would be the same wrong turn in a class we ourselves introduced.
  invalid_subdomain: 'APP_ERROR_PUBLIC_DNS_INVALID_SUBDOMAIN',
  // The plan is the cause, and the Portal refuses every retry the same way, so
  // this copy names the plan and never promises a retry.
  subdomain_quota_exceeded: 'APP_ERROR_PUBLIC_DNS_QUOTA_EXCEEDED',
  duplicate_subdomain: 'APP_ERROR_PUBLIC_DNS_DUPLICATE_SUBDOMAIN',
  release_pending: 'APP_ERROR_PUBLIC_DNS_RELEASE_PENDING',
  // The Portal could not record the app, changed nothing, and the next sync retries.
  write_failed: 'APP_ERROR_PUBLIC_DNS_TEMPORARY',
};

export const SSEProvider = ({ children }: PropsWithChildren) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Shows an error toast whose "see logs" text links to the Settings logs tab.
  const showLogsErrorToast = (i18nKey: string, appName: string) => {
    const toastId: string | number = toast.error(
      <Trans
        i18nKey={i18nKey}
        values={{ id: appName, logsLabel: t('COMMON_LOGS') }}
        components={{
          logsLink: <Link to={logsPageHref} className="font-medium underline" onClick={() => toast.dismiss(toastId)} />,
        }}
      />,
    );
  };

  useSSE({
    topic: 'app',
    onEvent: (data) => {
      const payload = data as AppSsePayload;
      const { event, appUrn, error, errorCode, settingsPath, warningCode, warningDetail } = payload;

      // The Hub's own greeting, first on every (re)connect. After a stack update this is
      // the new container announcing itself — the moment the Settings panel is waiting for.
      // In dev the bundle is Vite's and the version never matches the API's, so a same-origin
      // reload is a production-only concern.
      if (event === 'hub_hello') {
        applyHubHello(
          payload.version,
          { bundleVersion: import.meta.env.CI_HUB_VERSION, sameOriginBundle: usesSameOriginHubApi() && !import.meta.env.DEV },
          {
            invalidateVersion: () => void queryClient.invalidateQueries({ queryKey: appContextQueryKey() }),
            reload: () => window.location.reload(),
          },
        );
        return;
      }

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

      if (appStoreId === '_user' && (event === 'uninstall_success' || event === 'install_cancelled')) {
        navigate('/store', { replace: true });
      }

      switch (event) {
        case 'install_success':
          toast.success(t('APP_INSTALL_SUCCESS', { id: appName }));
          break;
        case 'install_error':
          if (errorCode === 'rocm_kfd_missing') {
            const toastId: string | number = toast.error(
              <Trans
                i18nKey="APP_ERROR_ROCM_KFD_MISSING_TOAST"
                values={{ id: appName }}
                components={{
                  settingsLink: (
                    <Link
                      to={settingsPath ?? '/settings?tab=ai&section=rocm'}
                      className="font-medium underline"
                      onClick={() => toast.dismiss(toastId)}
                    />
                  ),
                }}
              />,
            );
            break;
          }
          if (errorCode === 'network_overlap') {
            toast.error(t('APP_ERROR_NETWORK_OVERLAP_TOAST', { id: appName }));
            break;
          }
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_INSTALL_TOAST', appName);
          break;
        case 'install_cancelled':
          toast.success(t('APP_INSTALL_CANCELLED', { id: appName }));
          break;
        case 'start_success':
          toast.success(t('APP_START_SUCCESS', { id: appName }));
          break;
        case 'start_error':
          if (errorCode === 'network_overlap') {
            toast.error(t('APP_ERROR_NETWORK_OVERLAP_TOAST', { id: appName }));
            break;
          }
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_START_TOAST', appName);
          break;
        case 'stop_success':
          toast.success(t('APP_STOP_SUCCESS', { id: appName }));
          break;
        case 'stop_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_STOP_TOAST', appName);
          break;
        case 'uninstall_success':
          // The app is gone, but the delete may have left a remnant it couldn't
          // remove even via a privileged cleanup (e.g. a container-created root-owned
          // path, #907) — warn instead of claiming a clean removal. Branch on the
          // code's VALUE (like errorCode above): a future, unrecognized warningCode
          // must fall through to the plain success toast, not mislabel itself.
          if (warningCode === 'APP_UNINSTALL_PARTIAL_REMNANT') {
            if (warningDetail) {
              // Actionable: show the exact host path + command the operator can run.
              // Single-quote the path (escaping any embedded quote) and add `--`: an
              // operator-configured root can contain spaces or shell metacharacters, so
              // an unquoted path could be mis-split or read as an option on paste.
              const quotedPath = `'${warningDetail.replace(/'/g, "'\\''")}'`;
              const command = `sudo rm -rf -- ${quotedPath}`;
              toast.warning(
                <Trans
                  i18nKey="APP_UNINSTALL_PARTIAL_REMNANT_MANUAL"
                  values={{ id: appName, command }}
                  components={{ cmd: <code className="font-mono text-xs break-all" /> }}
                />,
                { duration: 20000 },
              );
            } else {
              toast.warning(t('APP_UNINSTALL_PARTIAL_REMNANT', { id: appName }), { duration: 8000 });
            }
          } else {
            toast.success(t('APP_UNINSTALL_SUCCESS', { id: appName }));
          }
          break;
        case 'uninstall_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_UNINSTALL_TOAST', appName);
          break;
        case 'update_success':
          toast.success(t('APP_UPDATE_SUCCESS', { id: appName }));
          break;
        case 'update_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_UPDATE_TOAST', appName);
          break;
        case 'reset_success':
          toast.success(t('APP_RESET_SUCCESS', { id: appName }));
          break;
        case 'reset_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_RESET_TOAST', appName);
          break;
        case 'restart_success':
          toast.success(t('APP_RESTART_SUCCESS', { id: appName }));
          break;
        case 'restart_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_RESTART_TOAST', appName);
          break;
        case 'backup_success':
          toast.success(t('APP_BACKUP_SUCCESS', { id: appName }));
          break;
        case 'backup_error':
          showLogsErrorToast('APP_BACKUP_ERROR_TOAST', appName);
          break;
        case 'restore_success':
          toast.success(t('APP_RESTORE_SUCCESS', { id: appName }));
          break;
        case 'restore_error':
          showLogsErrorToast('APP_RESTORE_ERROR_TOAST', appName);
          break;
        case 'public_dns_error':
          // errorCode carries Companion Portal's failure class. A conflict and an
          // unprovisioned domain need different actions from the user, so they
          // must not share the same message.
          toast.error(t(PUBLIC_DNS_ERROR_KEYS[errorCode ?? ''] ?? 'APP_ERROR_PUBLIC_DNS_FAILED', { id: appName }));
          break;
        case 'tailscale_serve_error': {
          const toastId: string | number = toast.error(
            <Trans
              i18nKey="APP_ERROR_TAILSCALE_SERVE_NOT_ENABLED_TOAST"
              values={{ id: appName }}
              components={{
                enableLink: (
                  // biome-ignore lint/a11y/useAnchorContent: link text is injected by Trans at runtime
                  <a
                    href="https://login.tailscale.com/admin/dns"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline"
                    onClick={() => toast.dismiss(toastId)}
                  />
                ),
              }}
            />,
            { duration: 10000 },
          );
          break;
        }
        default:
          break;
      }
    },
  });

  return children;
};
