import { appContextQueryKey, getStatus2Options, getStatus5Options, getStatus5QueryKey } from '@/api-client/@tanstack/react-query.gen';
import { disconnect, resetRegistration, startAuth } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
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
    className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
      connected
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
        : 'border-border/70 bg-muted/30 text-muted-foreground',
    )}
  >
    <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-muted-foreground/60')} />
    {label}
  </span>
);

/** Card header shared by both sections: icon + title on the left, connection state on the right —
 *  the same shape the App Stores / Security / System tabs use for their card headers. */
const SectionHeader = ({ icon: Icon, title, description, badge }: { icon: LucideIcon; title: string; description?: string; badge?: ReactNode }) => (
  <CardHeader>
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <CardTitle className="text-xl">{title}</CardTitle>
      </div>
      {badge}
    </div>
    {description ? <CardDescription>{description}</CardDescription> : null}
  </CardHeader>
);

/** Connection facts (tailnet IP, tunnel id, …) as compact label-over-value cells — the same shape
 *  the MCP tab uses for its status grid, so the value stays next to its label instead of being
 *  pushed to the far edge of the card. */
const DetailGrid = ({ children }: { children: ReactNode }) => <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{children}</dl>;

const Detail = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 space-y-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="truncate font-mono text-xs" title={value}>
      {value}
    </dd>
  </div>
);

const LoadingCard = ({ icon, title }: { icon: LucideIcon; title: string }) => (
  <Card>
    <SectionHeader icon={icon} title={title} />
    <CardContent className="space-y-3">
      <Skeleton className="h-4 w-2/3 rounded-md" />
      <Skeleton className="h-16 w-full rounded-md" />
    </CardContent>
  </Card>
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
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
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
    <CloudflareSection />
  </div>
);
