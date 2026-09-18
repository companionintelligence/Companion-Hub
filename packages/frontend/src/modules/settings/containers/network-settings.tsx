import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { cloudflareStatusOptions, tailscaleStatusOptions, tailscaleStatusQueryKey } from '@/lib/api-routes/named-status-routes';
import { disconnect, startAuth } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe, Shield } from 'lucide-react';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import toast from 'react-hot-toast';
import { openExternal } from '@/lib/helpers/open-external';
import { useTailscaleReadinessSync } from '@/lib/hooks/use-tailscale-readiness-sync';
import { Detail, DetailGrid, LoadingCard, SectionHeader, StatusBadge } from '../components/network-section/network-section';
import { HubAccountSection } from './hub-account-settings';
import { HubPoolSection } from './hub-pool-settings';

interface CloudflareStatus {
  tunnelEnabled: boolean;
  tunnelId: string | null;
  message: string;
}

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
    ...tailscaleStatusOptions(),
    select: (payload) => payload as unknown as TailscaleApiStatus,
    refetchInterval: 10_000,
  });

  useTailscaleReadinessSync(data);

  const invalidateTailscaleAndAppContext = () => {
    void queryClient.invalidateQueries({ queryKey: tailscaleStatusQueryKey() });
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
    return <LoadingCard icon={Shield} title={t('SETTINGS_NETWORK_PRIVATE_VPN_TITLE')} />;
  }

  const active = data?.installed && data?.connected;
  const cliUnavailable = data && !data.installed;
  const canConnectFlow = data?.installed && !active;

  return (
    <Card data-testid="private-vpn-card">
      <SectionHeader
        icon={Shield}
        title={t('SETTINGS_NETWORK_PRIVATE_VPN_TITLE')}
        badge={<StatusBadge connected={!!active} label={active ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')} />}
        actions={
          active ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={demoMode}
              loading={disconnectMutation.isPending}
              onClick={() => disconnectMutation.mutate()}
              data-testid="tailscale-disconnect-btn"
            >
              {t('SETTINGS_NETWORK_TAILSCALE_DISCONNECT')}
            </Button>
          ) : canConnectFlow ? (
            <Button
              type="button"
              size="sm"
              disabled={demoMode}
              loading={browserAuthMutation.isPending}
              onClick={() => browserAuthMutation.mutate()}
              data-testid="tailscale-connect-btn"
            >
              {t('ONBOARDING_TAILSCALE_LOGIN_BUTTON')}
            </Button>
          ) : null
        }
      />
      <CardContent className="space-y-3">
        {(data?.ip || data?.hostname || data?.backendState) && (
          <DetailGrid>
            {data?.ip && <Detail label={t('COMMON_TAILSCALE_IP')} value={data.ip} />}
            {data?.hostname && <Detail label={t('COMMON_HOSTNAME')} value={data.hostname} />}
            {data?.backendState && <Detail label={t('SETTINGS_NETWORK_TAILSCALE_STATE')} value={data.backendState} />}
          </DetailGrid>
        )}

        {/* The only prose left in this card, and only when something is actually wrong:
            a node with no Tailscale needs the remedy spelled out, and there is no state
            on screen for the reader to infer it from. */}
        {cliUnavailable && (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning">
            {t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED_DESC')}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

const CloudflareSection = () => {
  const { t } = useTranslation();

  const { data: status, isLoading } = useQuery({
    ...cloudflareStatusOptions(),
    select: (payload) => payload as unknown as CloudflareStatus,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <LoadingCard icon={Globe} title={t('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')} />;
  }

  return (
    <Card data-testid="cloudflare-tunnel-card">
      <SectionHeader
        icon={Globe}
        title={t('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')}
        badge={
          <StatusBadge
            connected={!!status?.tunnelEnabled}
            label={status?.tunnelEnabled ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')}
          />
        }
      />
      <CardContent className="space-y-3">
        {status?.tunnelId && (
          <DetailGrid>
            <Detail label={t('SETTINGS_NETWORK_TUNNEL_ID')} value={status.tunnelId} />
          </DetailGrid>
        )}
        {/* The tunnel's own message replaces the static section description: when the
            tunnel is fine it says so in a few words, and when it is not it says why —
            which the removed boilerplate never did. */}
        {status?.message && <p className="text-xs text-muted-foreground">{status.message}</p>}
      </CardContent>
    </Card>
  );
};

export const NetworkSettingsContainer = () => (
  <div className="space-y-6" data-testid="network-settings">
    <TailscaleSidecarSection />
    <HubPoolSection />
    <CloudflareSection />
    <HubAccountSection />
  </div>
);
