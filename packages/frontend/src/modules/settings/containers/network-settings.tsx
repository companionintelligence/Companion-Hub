import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Globe, Loader2, Shield } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import toast from 'react-hot-toast';

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

  const { data, isLoading } = useQuery<TailscaleApiStatus>({
    queryKey: ['tailscale-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/tailscale/status', { credentials: 'include' });
      return res.json();
    },
    refetchInterval: 10_000,
  });

  const invalidateTailscaleAndAppContext = () => {
    void queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
    void queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
  };

  const browserAuthMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/tailscale/auth/start', { method: 'POST', credentials: 'include' });
      return res.json() as Promise<AuthStartResponse>;
    },
    onSuccess: (payload) => {
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
        window.open(payload.authUrl, '_blank', 'noopener,noreferrer');
        toast.success(t('SETTINGS_NETWORK_TAILSCALE_AUTH_OPENING'));
        invalidateTailscaleAndAppContext();
      }
    },
    onError: () => toast.error(t('SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED')),
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/tailscale/disconnect', { method: 'POST', credentials: 'include' });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) {
        throw new Error(json.error ?? 'Failed to disconnect');
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
          <div className="text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_IP')}</div>
          <div className="font-mono">{data.ip}</div>
          {data.hostname && (
            <>
              <div className="text-muted-foreground">{t('SETTINGS_NETWORK_HOSTNAME')}</div>
              <div className="font-mono">{data.hostname}</div>
            </>
          )}
        </div>
      )}

      {cliUnavailable && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED_DESC')}</p>
          <p className="text-xs text-muted-foreground">
            <strong>Note:</strong> You can also install Tailscale on the host and mount tailscaled.sock into the Hub container.
          </p>
        </div>
      )}

      {canConnectFlow && (
        <div className="space-y-3 pt-2 border-t">
          <p className="text-sm text-muted-foreground">Click the button below to log in with your Tailscale account and connect your Hub.</p>
          <Button
            type="button"
            variant="default"
            size="lg"
            className="w-full"
            disabled={browserAuthMutation.isPending}
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
                Log In with Tailscale
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground text-center">Don't have a Tailscale account? You can create one for free during login.</p>
        </div>
      )}

      {active && (
        <div className="pt-2 border-t">
          <Button type="button" variant="outline" disabled={disconnectMutation.isPending} onClick={() => disconnectMutation.mutate()}>
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
  const [isResetting, setIsResetting] = useState(false);

  const { data: status, isLoading } = useQuery<CloudflareStatus>({
    queryKey: ['cloudflare-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/cloudflare/status', { credentials: 'include' });
      return res.json();
    },
    refetchInterval: 30000,
  });

  const handleResetRegistration = async () => {
    if (
      !window.confirm(
        'This will disconnect your device from the Portal and Cloudflare tunnel. You will need to re-pair with a new pairing code. Continue?',
      )
    )
      return;
    setIsResetting(true);
    try {
      const res = await apiFetch('/api/registration/reset', { method: 'POST' });
      if (res.ok) {
        toast.success('Registration reset. Redirecting to device registration...');
        sessionStorage.removeItem('device-registered');
        sessionStorage.removeItem('device-registered-at');
        setTimeout(() => {
          window.location.href = '/device-registration';
        }, 1500);
      } else {
        toast.error('Failed to reset registration');
      }
    } catch {
      toast.error('Failed to reset registration');
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
          <span className="font-medium">Cloudflare Tunnel</span>
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
          disabled={isResetting}
          className="text-sm text-destructive hover:text-destructive/80 underline"
        >
          {isResetting ? 'Resetting...' : 'Re-register Device'}
        </button>
        <p className="text-xs text-muted-foreground mt-1">Disconnect from the Portal and Cloudflare tunnel. You'll need a new pairing code.</p>
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
