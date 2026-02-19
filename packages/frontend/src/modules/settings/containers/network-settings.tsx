import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe, Shield, WifiOff, ExternalLink, Loader2 } from 'lucide-react';

interface TailscaleStatus {
  installed: boolean;
  connected: boolean;
  version: string | null;
  hostname: string | null;
  tailnet: string | null;
  ip: string | null;
  supportsServices: boolean;
  backendState: string | null;
}

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

const TailscaleSection = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery<TailscaleStatus>({
    queryKey: ['tailscale-status'],
    queryFn: async () => {
      const res = await fetch('/api/tailscale/status', { credentials: 'include' });
      return res.json();
    },
    refetchInterval: 10000,
  });

  const startAuth = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/tailscale/auth/start', {
        method: 'POST',
        credentials: 'include',
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.authUrl) {
        window.open(data.authUrl, '_blank');
        // Poll for auth completion
        const interval = setInterval(async () => {
          const res = await fetch('/api/tailscale/auth/check', { credentials: 'include' });
          const check = await res.json();
          if (check.authenticated) {
            clearInterval(interval);
            queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
          }
        }, 3000);
        // Stop polling after 5 min
        setTimeout(() => clearInterval(interval), 300000);
      } else {
        queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
      }
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/tailscale/disconnect', {
        method: 'POST',
        credentials: 'include',
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('SETTINGS_NETWORK_LOADING')}
      </div>
    );
  }

  if (!status?.installed) {
    return (
      <div className="rounded-lg border border-dashed p-4">
        <div className="flex items-center gap-2 mb-2">
          <WifiOff className="h-5 w-5 text-muted-foreground" />
          <span className="font-medium">{t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED')}</span>
        </div>
        <p className="text-sm text-muted-foreground mb-3">{t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED_DESC')}</p>
        <a
          href="https://tailscale.com/download/linux"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t('SETTINGS_NETWORK_TAILSCALE_INSTALL_LINK')}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <span className="font-medium">Tailscale</span>
          </div>
          <StatusBadge connected={false} label={t('SETTINGS_NETWORK_DISCONNECTED')} />
        </div>
        <p className="text-sm text-muted-foreground mb-3">{t('SETTINGS_NETWORK_TAILSCALE_CONNECT_DESC')}</p>
        <button
          type="button"
          onClick={() => startAuth.mutate()}
          disabled={startAuth.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {startAuth.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
          {t('SETTINGS_NETWORK_TAILSCALE_CONNECT')}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <span className="font-medium">Tailscale</span>
        </div>
        <StatusBadge connected label={t('SETTINGS_NETWORK_CONNECTED')} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm mb-3">
        <div className="text-muted-foreground">{t('SETTINGS_NETWORK_HOSTNAME')}</div>
        <div className="font-mono">
          {status.hostname}.{status.tailnet}.ts.net
        </div>
        <div className="text-muted-foreground">{t('SETTINGS_NETWORK_TAILNET_IP')}</div>
        <div className="font-mono">{status.ip}</div>
        <div className="text-muted-foreground">{t('SETTINGS_NETWORK_VERSION')}</div>
        <div>{status.version}</div>
      </div>
      <button
        type="button"
        onClick={() => disconnect.mutate()}
        disabled={disconnect.isPending}
        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {disconnect.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
        {t('SETTINGS_NETWORK_TAILSCALE_DISCONNECT')}
      </button>
    </div>
  );
};

const CloudflareSection = () => {
  const { t } = useTranslation();

  const { data: status, isLoading } = useQuery<CloudflareStatus>({
    queryKey: ['cloudflare-status'],
    queryFn: async () => {
      const res = await fetch('/api/cloudflare/status', { credentials: 'include' });
      return res.json();
    },
    refetchInterval: 30000,
  });

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

      <CloudflareSection />
      <TailscaleSection />
    </div>
  );
};
