import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { useSSE } from '@/lib/hooks/use-sse';
import { applyHubHello } from '@/lib/hub-hello';
import { usesSameOriginHubApi } from '@/lib/hub-runtime-mode';
import { appServiceFailureText } from '@/modules/app/helpers/app-service-failure';
import { cachedAppName, handleAppSseEvent, invalidateAppRecords, type AppSsePayload } from '@/modules/app/helpers/app-sse-cache';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppServiceFailure } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { useQueryClient } from '@tanstack/react-query';
import { type PropsWithChildren, useRef } from 'react';
import { toast } from 'sonner';
import { Trans, useTranslation } from 'react-i18next';
import { Link, matchPath, useLocation, useNavigate } from 'react-router';

const logsPageHref = '/settings?tab=logs';

/** The machine can't run this app. No log of an app that never started will say more, so the toast names it. */
const HOST_CAPABILITY_ERROR_KEYS: Record<string, string> = {
  kvm_missing: 'APP_ERROR_KVM_MISSING',
  kata_runtime_missing: 'APP_ERROR_KATA_RUNTIME_MISSING',
};

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

/** Whether this is a custom app's page or its edit page. `/apps/<store>/<app>` is a store app's page, even if a custom app has the store's name. */
const isCustomAppPage = (pathname: string, appId: string) => matchPath('/apps/:appId/edit?', pathname)?.params.appId === appId;

export const SSEProvider = ({ children }: PropsWithChildren) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // `useSSE` keeps the handler from the first render, so where this tab is now has to be read through a ref.
  const pathname = useRef('');
  pathname.current = useLocation().pathname;
  const greetedBefore = useRef(false);

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

  // A move is the news of this outcome, so it takes the place of the success toast: stacked under or
  // over a "started successfully", it is easy to miss that the app's address has changed.
  const showPortMoved = (appName: string, moved: NonNullable<AppSsePayload['movedHostPort']>) => {
    toast.warning(t('APP_NOTICE_HOST_PORT_MOVED', { id: appName, port: moved.to, previousPort: moved.from }), {
      duration: 20000,
    });
  };

  const showSuccessOrPortMoved = (successKey: string, appName: string, moved: AppSsePayload['movedHostPort']) => {
    if (moved) {
      showPortMoved(appName, moved);
    } else {
      toast.success(t(successKey, { id: appName }));
    }
  };

  const showHostCapabilityToast = (errorCode: string | undefined): boolean => {
    const key = errorCode ? HOST_CAPABILITY_ERROR_KEYS[errorCode] : undefined;
    if (key) {
      toast.error(t(key));
    }
    return Boolean(key);
  };

  /**
   * A refusal the Hub can name: a missing host device or a Docker network clash. Install, start and
   * restart all run the same checks, so all three say what stopped them instead of "see logs" (#2376).
   * Returns whether it showed a toast.
   */
  const showRefusalToast = (errorCode: string | undefined, appName: string, settingsPath: string | undefined): boolean => {
    if (errorCode === 'rocm_kfd_missing') {
      const toastId: string | number = toast.error(
        <Trans
          i18nKey="APP_ERROR_ROCM_KFD_MISSING_TOAST"
          values={{ id: appName }}
          components={{
            settingsLink: (
              <Link to={settingsPath ?? '/settings?tab=ai&section=rocm'} className="font-medium underline" onClick={() => toast.dismiss(toastId)} />
            ),
          }}
        />,
      );
      return true;
    }
    if (errorCode === 'network_overlap') {
      toast.error(t('APP_ERROR_NETWORK_OVERLAP_TOAST', { id: appName }));
      return true;
    }
    return showHostCapabilityToast(errorCode);
  };

  // The service's name comes from the app's compose file, so it stays plain text: `Trans` would read tags in it.
  const showServiceFailureToast = (i18nKey: string, appName: string, failure: AppServiceFailure) => {
    toast.error(t(i18nKey, { id: appName, reason: appServiceFailureText(t, failure) }), { duration: 10000 });
  };

  // What an uninstall or a cancelled install could not remove. With the host path of the files, gives the command to delete them.
  const showRemnantWarning = (keys: { plain: string; manual: string }, appName: string, hostPath: string | undefined) => {
    if (!hostPath) {
      toast.warning(t(keys.plain, { id: appName }), { duration: 8000 });
      return;
    }
    // Single-quote the path (escaping any embedded quote) and add `--`: an operator-configured root
    // can contain spaces or shell metacharacters, so an unquoted path could be mis-split or read as
    // an option on paste.
    const command = `sudo rm -rf -- '${hostPath.replace(/'/g, "'\\''")}'`;
    toast.warning(
      <Trans i18nKey={keys.manual} values={{ id: appName, command }} components={{ cmd: <code className="font-mono text-xs break-all" /> }} />,
      { duration: 20000 },
    );
  };

  useSSE({
    topic: 'app',
    onEvent: (data) => {
      const payload = data as AppSsePayload;
      const { event, appUrn, error, errorCode, settingsPath, serviceFailure, warningCode, warningDetail, movedHostPort } = payload;

      // The Hub's own greeting, first on every (re)connect. After a stack update this is
      // the new container announcing itself — the moment the Settings panel is waiting for.
      // In dev the bundle is Vite's and the version never matches the API's, so a same-origin
      // reload is a production-only concern.
      if (event === 'hub_hello') {
        // Any greeting after the first means the stream dropped and came back, most often a Hub restart.
        if (greetedBefore.current) {
          invalidateAppRecords(queryClient);
        }
        greetedBefore.current = true;
        applyHubHello(
          payload.version,
          {
            bundleVersion: import.meta.env.CI_HUB_VERSION,
            helloBuildVersion: payload.buildVersion,
            sameOriginBundle: usesSameOriginHubApi() && !import.meta.env.DEV,
          },
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

      // Read before the cache takes the event: an uninstall takes the name with it.
      const cachedName = appUrn ? cachedAppName(queryClient, appUrn, '') : '';

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

      const { appName: appId, appStoreId } = extractAppUrn(appUrn as AppUrn);
      // As its page names it ("Uptime Kuma"), not by its id ("uptime-kuma"), in every toast: a failed
      // install's error and its port notice arrive together.
      const appName = cachedName || appId;

      // A cancelled retry of a failed install leaves the app there, failed, so its page stays.
      const appGone = event === 'uninstall_success' || (event === 'install_cancelled' && payload.appStatus !== 'install_failed');
      // The event reaches every tab and every operator. Only a tab showing the app has lost its page.
      if (appStoreId === '_user' && appGone && isCustomAppPage(pathname.current, appId)) {
        navigate('/store', { replace: true });
      }

      // A command that failed after the move leaves the app on the new port, so the error alone would hide it.
      if (movedHostPort && (event === 'start_error' || event === 'restart_error' || event === 'install_error')) {
        showPortMoved(appName, movedHostPort);
      }

      switch (event) {
        case 'host_port_moved':
          if (movedHostPort) {
            showPortMoved(appName, movedHostPort);
          }
          break;
        case 'install_success':
          showSuccessOrPortMoved('APP_INSTALL_SUCCESS', appName, movedHostPort);
          break;
        case 'install_error':
          if (showRefusalToast(errorCode, appName, settingsPath)) {
            break;
          }
          if (serviceFailure) {
            showServiceFailureToast('APP_ERROR_APP_FAILED_TO_INSTALL_BECAUSE', appName, serviceFailure);
            break;
          }
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_INSTALL_TOAST', appName);
          break;
        case 'install_cancelled':
          if (warningCode === 'APP_INSTALL_CANCELLED_PARTIAL_REMNANT') {
            showRemnantWarning(
              { plain: 'APP_INSTALL_CANCELLED_PARTIAL_REMNANT', manual: 'APP_INSTALL_CANCELLED_PARTIAL_REMNANT_MANUAL' },
              appName,
              warningDetail,
            );
          } else if (warningCode === 'APP_INSTALL_CANCELLED_PARTIAL_REMNANT_KEY_REMAINS') {
            showRemnantWarning(
              { plain: 'APP_INSTALL_CANCELLED_PARTIAL_REMNANT_KEY_REMAINS', manual: 'APP_INSTALL_CANCELLED_PARTIAL_REMNANT_KEY_REMAINS_MANUAL' },
              appName,
              warningDetail,
            );
          } else if (warningCode === 'APP_INSTALL_CANCELLED_KEY_REMAINS') {
            toast.warning(t('APP_INSTALL_CANCELLED_KEY_REMAINS', { id: appName }), { duration: 8000 });
          } else {
            toast.success(t('APP_INSTALL_CANCELLED', { id: appName }));
          }
          break;
        case 'start_success':
          showSuccessOrPortMoved('APP_START_SUCCESS', appName, movedHostPort);
          break;
        case 'start_error':
          if (showRefusalToast(errorCode, appName, settingsPath)) {
            break;
          }
          if (serviceFailure) {
            showServiceFailureToast('APP_ERROR_APP_FAILED_TO_START_BECAUSE', appName, serviceFailure);
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
            showRemnantWarning({ plain: 'APP_UNINSTALL_PARTIAL_REMNANT', manual: 'APP_UNINSTALL_PARTIAL_REMNANT_MANUAL' }, appName, warningDetail);
          } else {
            toast.success(t('APP_UNINSTALL_SUCCESS', { id: appName }));
          }
          break;
        case 'uninstall_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_UNINSTALL_TOAST', appName);
          break;
        case 'update_success':
          if (warningCode === 'APP_UPDATE_SETTINGS_NOT_REAPPLIED') {
            toast.warning(t('APP_UPDATE_SETTINGS_NOT_REAPPLIED', { id: appName }), { duration: 10000 });
            break;
          }
          toast.success(t('APP_UPDATE_SUCCESS', { id: appName }));
          break;
        case 'update_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_UPDATE_TOAST', appName);
          break;
        case 'update_cancelled':
          toast.success(t('APP_UPDATE_CANCELLED', { id: appName }));
          break;
        case 'reset_success':
          toast.success(t('APP_RESET_SUCCESS', { id: appName }));
          break;
        case 'reset_error':
          showLogsErrorToast('APP_ERROR_APP_FAILED_TO_RESET_TOAST', appName);
          break;
        case 'restart_success':
          showSuccessOrPortMoved('APP_RESTART_SUCCESS', appName, movedHostPort);
          break;
        case 'restart_error':
          if (showRefusalToast(errorCode, appName, settingsPath)) {
            break;
          }
          if (serviceFailure) {
            showServiceFailureToast('APP_ERROR_APP_FAILED_TO_RESTART_BECAUSE', appName, serviceFailure);
            break;
          }
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
        case 'public_domain_changed':
          // Not an error: the app IS published, only not on the domain it asked
          // for. A warning, because that choice was overridden.
          if (payload.hostname) {
            toast.warning(t('APP_NOTICE_PUBLIC_DOMAIN_MOVED', { id: appName, hostname: payload.hostname }), { duration: 10000 });
          }
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
