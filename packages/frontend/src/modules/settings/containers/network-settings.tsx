import { appContextQueryKey, getStatus2Options, getStatus4Options, getStatus4QueryKey } from '@/api-client/@tanstack/react-query.gen';
import { disconnect, resetRegistration, startAuth } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe, Loader2, Shield } from 'lucide-react';
import { useState } from 'react';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import toast from 'react-hot-toast';
import { openExternal } from '@/lib/helpers/open-external';
import { useTailscaleReadinessSync } from '@/lib/hooks/use-tailscale-readiness-sync';

interface CloudflareStatus {
  tunnelEnabled: boolean;
  tunnelId: string | null;
  message: string;
}

const StatusBadge = ({ connected, label }: { connected: boolean; label: string }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${connected ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}
  >
    <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
    {label}
  </span>
);

interface TailscaleApiStatus {
  installed: boolean;
  connected: boolean;
  ip: string | null;
  hostname: string | null;
  backendState: string | null;
  httpsAvailable?: boolean;
}

interface AuthStartResponse {
  success: boolean;
  authUrl?: string;
  alreadyAuthenticated?: boolean;
  error?: string;
}

const TailscaleSidecarSection = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const demoMode = useDemoMode();

  const { data, isLoading } = useQuery({
    ...getStatus4Options(),
    select: (payload) => payload as unknown as TailscaleApiStatus,
    refetchInterval: 10_000,
  });

  useTailscaleReadinessSync(data);

  const invalidateTailscaleAndAppContext = () => {
    void queryClient.invalidateQueries({ queryKey: getStatus4QueryKey() });
    void queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
  };

  const browserAuthMutation = useMutation({
    mutationFn: async () => {
      const result = await startAuth();
      if (result.error) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      return result.data as unknown as AuthStartResponse;
    },
    onSuccess: (payload: AuthStartResponse) => {
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
        openExternal(payload.authUrl);
        toast.success(t('SETTINGS_NETWORK_TAILSCALE_AUTH_OPENING'));
        invalidateTailscaleAndAppContext();
      }
    },
    onError: () => toast.error(t('SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED')),
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const result = await disconnect();
      if (result.error) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      const json = result.data as { success: boolean; error?: string };
      if (!json.success) {
        throw new Error(json.error ?? t('SETTINGS_NETWORK_DISCONNECT_FAILED'));
      }
    },
    onSuccess: () => {
      toast.success(t('SETTINGS_NETWORK_DISCONNECTED'));
      invalidateTailscaleAndAppContext();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('SETTINGS_NETWORK_LOADING')}
      </div>
    );
  }

  const active = data?.installed && data?.connected;
  const cliUnavailable = data && !data.installed;
  const canConnectFlow = data?.installed && !active;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <span className="font-medium">{t('SETTINGS_NETWORK_PRIVATE_VPN_TITLE')}</span>
        </div>
        <StatusBadge connected={!!active} label={active ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')} />
      </div>
      <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_PRIVATE_VPN_DESC')}</p>

      {data?.backendState && !active && (
        <p className="text-xs text-muted-foreground font-mono">
          {t('SETTINGS_NETWORK_TAILSCALE_STATE')}: {data.backendState}
        </p>
      )}

      {data?.ip && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-muted-foreground">{t('COMMON_TAILSCALE_IP')}</div>
          <div className="font-mono">{data.ip}</div>
          {data.hostname && (
            <>
              <div className="text-muted-foreground">{t('COMMON_HOSTNAME')}</div>
              <div className="font-mono">{data.hostname}</div>
            </>
          )}
        </div>
      )}

      {cliUnavailable && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED_DESC')}</p>
          <p className="text-xs text-muted-foreground">
            <strong>{t('COMMON_NOTE')}:</strong> {t('SETTINGS_NETWORK_TAILSCALE_HOST_NOTE')}
          </p>
        </div>
      )}

      {canConnectFlow && (
        <div className="space-y-3 pt-2 border-t">
          <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_CONNECT_HELP')}</p>
          <Button
            type="button"
            variant="default"
            size="lg"
            className="w-full"
            disabled={demoMode || browserAuthMutation.isPending}
            onClick={() => browserAuthMutation.mutate()}
          >
            {browserAuthMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('SETTINGS_NETWORK_LOADING')}
              </>
            ) : (
              <>
                <Shield className="h-4 w-4 mr-2" />
                {t('ONBOARDING_TAILSCALE_LOGIN_BUTTON')}
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground text-center">{t('SETTINGS_NETWORK_TAILSCALE_NO_ACCOUNT')}</p>
        </div>
      )}

      {active && (
        <div className="pt-2 border-t">
          <Button type="button" variant="outline" disabled={demoMode || disconnectMutation.isPending} onClick={() => disconnectMutation.mutate()}>
            {disconnectMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('SETTINGS_NETWORK_LOADING')}
              </>
            ) : (
              t('SETTINGS_NETWORK_TAILSCALE_DISCONNECT')
            )}
          </Button>
        </div>
      )}
    </div>
  );
};

const CloudflareSection = () => {
  const { t } = useTranslation();
  const demoMode = useDemoMode();
  const [isResetting, setIsResetting] = useState(false);

  const { data: status, isLoading } = useQuery({
    ...getStatus2Options(),
    select: (payload) => payload as CloudflareStatus,
    refetchInterval: 30_000,
  });

  const handleResetRegistration = async () => {
    if (demoMode) {
      toast.error(t('SERVER_ERROR_NOT_ALLOWED_IN_DEMO'));
      return;
    }
    if (!window.confirm(t('SETTINGS_NETWORK_RESET_REGISTRATION_CONFIRM'))) return;
    setIsResetting(true);
    try {
      const result = await resetRegistration();
      if (result.error) {
        toast.error(t('SETTINGS_NETWORK_RESET_REGISTRATION_ERROR'));
        return;
      }
      toast.success(t('SETTINGS_NETWORK_RESET_REGISTRATION_SUCCESS'));
      clearClientHubState({ keepPortalEmail: true });
      setTimeout(() => {
        window.location.href = '/device-registration';
      }, 1500);
    } catch {
      toast.error(t('SETTINGS_NETWORK_RESET_REGISTRATION_ERROR'));
    } finally {
      setIsResetting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('SETTINGS_NETWORK_LOADING')}
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-primary" />
          <span className="font-medium">{t('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')}</span>
        </div>
        <StatusBadge
          connected={!!status?.tunnelEnabled}
          label={status?.tunnelEnabled ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')}
        />
      </div>
      {status?.tunnelId && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-muted-foreground">{t('SETTINGS_NETWORK_TUNNEL_ID')}</div>
          <div className="font-mono text-xs">{status.tunnelId}</div>
        </div>
      )}
      <p className="text-sm text-muted-foreground mt-2">{status?.message}</p>
      <div className="mt-3 pt-3 border-t">
        <button
          type="button"
          onClick={handleResetRegistration}
          disabled={demoMode || isResetting}
          className="text-sm text-destructive hover:text-destructive/80 underline disabled:opacity-50 disabled:pointer-events-none"
        >
          {isResetting ? t('SETTINGS_NETWORK_RESETTING') : t('SETTINGS_NETWORK_REREGISTER_DEVICE')}
        </button>
        <p className="text-xs text-muted-foreground mt-1">{t('SETTINGS_NETWORK_REREGISTER_HINT')}</p>
      </div>
    </div>
  );
};

export const NetworkSettingsContainer = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-medium mb-1">{t('SETTINGS_NETWORK_TITLE')}</h3>
        <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_DESC')}</p>
      </div>

      <TailscaleSidecarSection />
      <CloudflareSection />
    </div>
  );
};
