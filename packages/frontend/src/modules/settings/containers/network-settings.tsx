import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ExternalLink, Globe, Loader2, Shield, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  sidecarAuthKeyConfigured: boolean;
  /** Present on newer Hub builds; used to explain Docker vs CLI mismatch */
  sidecarContainerRunning?: boolean;
}

interface AuthStartResponse {
  success: boolean;
  authUrl?: string;
  alreadyAuthenticated?: boolean;
  error?: string;
}

interface AuthKeyResponse {
  success: boolean;
  error?: string;
}

function isMissingI18n(value: string): boolean {
  return value.startsWith('SETTINGS_NETWORK_') || value.startsWith('SETTINGS_');
}

function formatBackendState(state: string | null, t: TFunction): string {
  const raw = state?.trim();
  if (!raw) {
    const idle = t('SETTINGS_NETWORK_TAILSCALE_BS_NoState');
    return isMissingI18n(idle) ? 'Idle' : idle;
  }
  const key = `SETTINGS_NETWORK_TAILSCALE_BS_${raw}`;
  const translated = t(key);
  if (translated !== key && !isMissingI18n(translated)) {
    return translated;
  }
  const withVar = t('SETTINGS_NETWORK_TAILSCALE_BS_fallback', { state: raw });
  if (!isMissingI18n(withVar) && withVar !== 'SETTINGS_NETWORK_TAILSCALE_BS_fallback') {
    return withVar;
  }
  return raw;
}

const TailscaleSidecarSection = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [authKey, setAuthKey] = useState('');
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);

  const { data, isLoading } = useQuery<TailscaleApiStatus>({
    queryKey: ['tailscale-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/tailscale/status', { credentials: 'include' });
      if (!res.ok) {
        throw new Error('Failed to load Tailscale status');
      }
      return res.json();
    },
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (data?.connected) {
      setPendingAuthUrl(null);
    }
  }, [data?.connected]);

  const invalidateTailscaleAndAppContext = () => {
    void queryClient.invalidateQueries({ queryKey: ['tailscale-status'] });
    void queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
  };

  const browserAuthMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/tailscale/auth/start', { method: 'POST', credentials: 'include' });
      const payload = (await res.json()) as AuthStartResponse;
      if (!res.ok || !payload.success) {
        throw new Error(payload.error ?? t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED'));
      }
      return payload;
    },
    onSuccess: (payload) => {
      if (payload.alreadyAuthenticated) {
        toast.success(t('SETTINGS_NETWORK_TAILSCALE_ALREADY_CONNECTED'));
        invalidateTailscaleAndAppContext();
        return;
      }
      if (payload.authUrl) {
        setPendingAuthUrl(payload.authUrl);
        window.open(payload.authUrl, '_blank', 'noopener,noreferrer');
        toast.success(t('SETTINGS_NETWORK_TAILSCALE_AUTH_OPENING'));
        invalidateTailscaleAndAppContext();
      }
    },
    onError: (e: Error) => toast.error(e.message || t('SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED')),
  });

  const envKeyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/tailscale/auth/env', { method: 'POST', credentials: 'include' });
      const json = (await res.json()) as AuthKeyResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? t('SETTINGS_NETWORK_TAILSCALE_BROWSER_FAILED'));
      }
    },
    onSuccess: () => {
      toast.success(t('SETTINGS_NETWORK_CONNECTED'));
      invalidateTailscaleAndAppContext();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const keyAuthMutation = useMutation({
    mutationFn: async (key: string) => {
      const res = await apiFetch('/api/tailscale/auth/key', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authKey: key }),
      });
      const json = (await res.json()) as AuthKeyResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Failed to connect');
      }
    },
    onSuccess: () => {
      toast.success(t('SETTINGS_NETWORK_CONNECTED'));
      setAuthKey('');
      invalidateTailscaleAndAppContext();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/tailscale/disconnect', { method: 'POST', credentials: 'include' });
      const json = (await res.json()) as AuthKeyResponse;
      if (!res.ok || !json.success) {
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
  const showDockerEnv = !!data?.installed && data.sidecarAuthKeyConfigured;
  const showDockerSocketWarning = !!data && !data.installed && data.sidecarContainerRunning === true;

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <span className="font-medium">{t('SETTINGS_NETWORK_PRIVATE_VPN_TITLE')}</span>
        </div>
        <StatusBadge connected={!!active} label={active ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')} />
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed">{t('SETTINGS_NETWORK_PRIVATE_VPN_DESC')}</p>

      {pendingAuthUrl && (
        <Alert variant="info" className="space-y-3">
          <AlertDescription className="space-y-3">
            <p className="font-semibold">{t('SETTINGS_NETWORK_TAILSCALE_AUTH_CARD_TITLE')}</p>
            <p className="text-sm opacity-90">{t('SETTINGS_NETWORK_TAILSCALE_AUTH_CARD_BODY')}</p>
            <div className="flex flex-wrap gap-2 items-center">
              <Button type="button" variant="default" size="sm" asChild>
                <a href={pendingAuthUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5">
                  {t('SETTINGS_NETWORK_TAILSCALE_AUTH_OPEN_LINK')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(pendingAuthUrl).then(
                    () => toast.success(t('SETTINGS_NETWORK_COPIED')),
                    () => toast.error('Could not copy'),
                  );
                }}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                {t('SETTINGS_NETWORK_TAILSCALE_AUTH_COPY_LINK')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPendingAuthUrl(null)}>
                {t('SETTINGS_NETWORK_TAILSCALE_AUTH_DISMISS')}
              </Button>
            </div>
            <p className="text-xs font-mono break-all opacity-80">{pendingAuthUrl}</p>
          </AlertDescription>
        </Alert>
      )}

      {data?.backendState && (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_STATE')}: </span>
          <span className="font-medium">{formatBackendState(data.backendState, t)}</span>
        </div>
      )}

      {data?.ip && (
        <div className="grid grid-cols-2 gap-2 text-sm max-w-md">
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

      {showDockerSocketWarning && (
        <Alert variant="warning">
          <AlertDescription>
            <p className="font-semibold mb-1">{t('SETTINGS_NETWORK_TAILSCALE_DOCKER_WARN_TITLE')}</p>
            <p className="text-sm">{t('SETTINGS_NETWORK_TAILSCALE_DOCKER_WARN_BODY')}</p>
          </AlertDescription>
        </Alert>
      )}

      {cliUnavailable && !showDockerSocketWarning && (
        <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED_DESC')}</p>
      )}

      {canConnectFlow && (
        <div className="space-y-5 pt-2 border-t">
          {showDockerEnv && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">{t('SETTINGS_NETWORK_TAILSCALE_SECTION_DOCKER_KEY')}</h4>
              <p className="text-xs text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_CONNECT_ENV_DESC')}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="default" disabled={envKeyMutation.isPending} onClick={() => envKeyMutation.mutate()}>
                  {envKeyMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      {t('SETTINGS_NETWORK_LOADING')}
                    </>
                  ) : (
                    t('SETTINGS_NETWORK_TAILSCALE_CONNECT_ENV')
                  )}
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">{t('SETTINGS_NETWORK_TAILSCALE_SECTION_SIGNIN')}</h4>
            <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_CONNECT_DESC')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={showDockerEnv ? 'secondary' : 'default'}
                disabled={browserAuthMutation.isPending}
                onClick={() => browserAuthMutation.mutate()}
              >
                {browserAuthMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t('SETTINGS_NETWORK_LOADING')}
                  </>
                ) : (
                  t('SETTINGS_NETWORK_TAILSCALE_CONNECT')
                )}
              </Button>
              <Button type="button" variant="outline" asChild>
                <a
                  href="https://login.tailscale.com/admin/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5"
                >
                  {t('SETTINGS_NETWORK_TAILSCALE_GET_KEY')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">{t('SETTINGS_NETWORK_TAILSCALE_SECTION_PASTE_KEY')}</h4>
            <label className="text-sm font-medium sr-only" htmlFor="tailscale-preauth-key">
              {t('SETTINGS_NETWORK_TAILSCALE_PREAUTH_KEY_LABEL')}
            </label>
            <p className="text-xs text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_PREAUTH_HELP')}</p>
            <Input
              id="tailscale-preauth-key"
              type="password"
              autoComplete="off"
              placeholder={t('SETTINGS_NETWORK_TAILSCALE_PREAUTH_PLACEHOLDER')}
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              className="max-w-lg"
            />
            <Button
              type="button"
              variant="outline"
              disabled={keyAuthMutation.isPending || !authKey.trim()}
              onClick={() => keyAuthMutation.mutate(authKey)}
            >
              {keyAuthMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {t('SETTINGS_NETWORK_LOADING')}
                </>
              ) : (
                t('SETTINGS_NETWORK_TAILSCALE_CONNECT_KEY_SUBMIT')
              )}
            </Button>
          </div>
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
