import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { startAuth } from '@/api-client/sdk.gen';
import { openExternal } from '@/lib/helpers/open-external';
import { tailscaleStatusQueryKey } from '@/lib/api-routes/named-status-routes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

interface AuthStartResponse {
  success: boolean;
  authUrl?: string;
  alreadyAuthenticated?: boolean;
  error?: string;
}

/**
 * Starts Tailscale's browser sign-in: asks the Hub for an auth URL and opens it in the system browser.
 *
 * Shared by the Private VPN card and the Hub Pool setup guide, so the two cannot disagree about what
 * "Connect Tailscale" does. The caller learns that sign-in finished the way it always has, by
 * re-reading the Tailscale status, which this invalidates once the browser is on its way.
 *
 * `onBrowserOpened` fires only when the system opener reported success, so a caller that says "finish
 * signing in in the tab that opened" never says it after a failed open.
 */
export function useTailscaleBrowserAuth({ onBrowserOpened }: { onBrowserOpened?: () => void } = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const invalidateTailscaleAndAppContext = () => {
    void queryClient.invalidateQueries({ queryKey: tailscaleStatusQueryKey() });
    void queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
  };

  return useMutation({
    mutationFn: async () => {
      const result = await startAuth();
      if (result.error) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      return result.data as unknown as AuthStartResponse;
    },
    onSuccess: async (payload: AuthStartResponse) => {
      if (!payload.success) {
        toast.error(payload.error ?? t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED'));
        return;
      }
      if (payload.alreadyAuthenticated) {
        toast.success(t('SETTINGS_NETWORK_TAILSCALE_ALREADY_CONNECTED'));
        invalidateTailscaleAndAppContext();
        return;
      }
      if (payload.authUrl) {
        const opened = await openExternal(payload.authUrl);
        // openExternal never throws (it logs and returns false instead), so this
        // is the only signal that the system opener actually did anything -- skip
        // it and the button looks like it worked while nothing opened.
        toast[opened ? 'success' : 'error'](t(opened ? 'SETTINGS_NETWORK_TAILSCALE_AUTH_OPENING' : 'SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED'));
        if (opened) onBrowserOpened?.();
        invalidateTailscaleAndAppContext();
      }
    },
    onError: () => toast.error(t('SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED')),
  });
}
