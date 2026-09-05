import { appContextQueryKey, getStatus2Options, getStatus5Options, getStatus5QueryKey } from '@/api-client/@tanstack/react-query.gen';
import { disconnect, resetRegistration, startAuth } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe, Shield } from 'lucide-react';
import { useState } from 'react';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import toast from 'react-hot-toast';
import { openExternal } from '@/lib/helpers/open-external';
import { useTailscaleReadinessSync } from '@/lib/hooks/use-tailscale-readiness-sync';
import { Detail, DetailGrid, LoadingCard, SectionHeader, StatusBadge } from '../components/network-section/network-section';
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
    ...getStatus5Options(),
    select: (payload) => payload as unknown as TailscaleApiStatus,
    refetchInterval: 10_000,
  });

  useTailscaleReadinessSync(data);

  const invalidateTailscaleAndAppContext = () => {
    void queryClient.invalidateQueries({ queryKey: getStatus5QueryKey() });
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
        description={t('SETTINGS_NETWORK_PRIVATE_VPN_DESC')}
        badge={<StatusBadge connected={!!active} label={active ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')} />}
      />
      <CardContent className="space-y-4">
        {(data?.ip || (data?.backendState && !active)) && (
          <DetailGrid>
            {data?.ip && <Detail label={t('COMMON_TAILSCALE_IP')} value={data.ip} />}
            {data?.ip && data.hostname && <Detail label={t('COMMON_HOSTNAME')} value={data.hostname} />}
            {data?.backendState && !active && <Detail label={t('SETTINGS_NETWORK_TAILSCALE_STATE')} value={data.backendState} />}
          </DetailGrid>
        )}

        {cliUnavailable && (
          <div className="space-y-2">
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
              {t('SETTINGS_NETWORK_TAILSCALE_NOT_INSTALLED_DESC')}
            </p>
            <p className="text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">{t('COMMON_NOTE')}:</strong> {t('SETTINGS_NETWORK_TAILSCALE_HOST_NOTE')}
            </p>
          </div>
        )}

        {canConnectFlow && (
          <div className="space-y-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_CONNECT_HELP')}</p>
            <Button
              type="button"
              disabled={demoMode}
              loading={browserAuthMutation.isPending}
              onClick={() => browserAuthMutation.mutate()}
              data-testid="tailscale-connect-btn"
            >
              {browserAuthMutation.isPending ? t('SETTINGS_NETWORK_LOADING') : t('ONBOARDING_TAILSCALE_LOGIN_BUTTON')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('SETTINGS_NETWORK_TAILSCALE_NO_ACCOUNT')}</p>
          </div>
        )}

        {active && (
          <div className="border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={demoMode}
              loading={disconnectMutation.isPending}
              onClick={() => disconnectMutation.mutate()}
              data-testid="tailscale-disconnect-btn"
            >
              {disconnectMutation.isPending ? t('SETTINGS_NETWORK_LOADING') : t('SETTINGS_NETWORK_TAILSCALE_DISCONNECT')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const CloudflareSection = () => {
  const { t } = useTranslation();
  const demoMode = useDemoMode();
  const [isResetting, setIsResetting] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  const { data: status, isLoading } = useQuery({
    ...getStatus2Options(),
    select: (payload) => payload as unknown as CloudflareStatus,
    refetchInterval: 30_000,
  });

  const handleResetRegistration = async () => {
    if (demoMode) {
      toast.error(t('SERVER_ERROR_NOT_ALLOWED_IN_DEMO'));
      return;
    }
    setResetConfirmOpen(false);
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
    return <LoadingCard icon={Globe} title={t('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')} />;
  }

  return (
    <Card data-testid="cloudflare-tunnel-card">
      <SectionHeader
        icon={Globe}
        title={t('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')}
        description={status?.message}
        badge={
          <StatusBadge
            connected={!!status?.tunnelEnabled}
            label={status?.tunnelEnabled ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')}
          />
        }
      />
      <CardContent className="space-y-4">
        {status?.tunnelId && (
          <DetailGrid>
            <Detail label={t('SETTINGS_NETWORK_TUNNEL_ID')} value={status.tunnelId} />
          </DetailGrid>
        )}

        <div className="space-y-3 border-t pt-4">
          <div>
            <h3 className="text-sm font-medium">{t('SETTINGS_NETWORK_REREGISTER_DEVICE')}</h3>
            <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_REREGISTER_HINT')}</p>
          </div>
          <Button
            type="button"
            intent="danger"
            variant="outline"
            disabled={demoMode}
            loading={isResetting}
            onClick={() => setResetConfirmOpen(true)}
            data-testid="reregister-device-btn"
          >
            {isResetting ? t('SETTINGS_NETWORK_RESETTING') : t('SETTINGS_NETWORK_REREGISTER_DEVICE')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent type="danger" size="sm">
          <DialogHeader>
            <DialogTitle>{t('SETTINGS_NETWORK_REREGISTER_DEVICE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="py-2">{t('SETTINGS_NETWORK_RESET_REGISTRATION_CONFIRM')}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetConfirmOpen(false)} disabled={isResetting}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button intent="danger" loading={isResetting} onClick={handleResetRegistration} data-testid="reregister-confirm-btn">
              {t('SETTINGS_NETWORK_REREGISTER_DEVICE')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export const NetworkSettingsContainer = () => (
  <div className="space-y-6" data-testid="network-settings">
    <TailscaleSidecarSection />
    <HubPoolSection />
    <CloudflareSection />
  </div>
);
