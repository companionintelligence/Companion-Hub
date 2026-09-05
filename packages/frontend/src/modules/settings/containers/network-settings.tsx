import {
  appContextQueryKey,
  getStatus2Options,
  getStatus5Options,
  getStatus5QueryKey,
  listDiscoverableOptions,
  listDiscoverableQueryKey,
  listPeersOptions,
  listPeersQueryKey,
} from '@/api-client/@tanstack/react-query.gen';
import { approvePeer, disconnect, pairPeer, rejectPeer, removePeer, resetRegistration, startAuth } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe, Network, Shield } from 'lucide-react';
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
      connected ? 'border-success/40 bg-success/10 text-success' : 'border-border/70 bg-muted/30 text-muted-foreground',
    )}
  >
    <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-success' : 'bg-muted-foreground/60')} />
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

interface DiscoverablePoolPeer {
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
}

interface PoolPeer {
  id: string;
  nodeFqdn: string;
  displayName: string | null;
  direction: 'inbound' | 'outbound';
  status: 'pending' | 'connected' | 'unreachable' | 'rejected';
  lastSeenAt: string | null;
}

const peerLabel = (peer: { displayName: string | null; nodeFqdn: string }) => peer.displayName || peer.nodeFqdn;

const PoolPeerStatusBadge = ({ status, t }: { status: PoolPeer['status']; t: (key: string) => string }) => {
  if (status === 'connected') {
    return <StatusBadge connected label={t('HUB_POOL_STATUS_CONNECTED')} />;
  }
  if (status === 'unreachable') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
        {t('HUB_POOL_STATUS_UNREACHABLE')}
      </span>
    );
  }
  return <StatusBadge connected={false} label={t('HUB_POOL_STATUS_PENDING')} />;
};

const HubPoolSection = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const demoMode = useDemoMode();

  const { data: peers, isLoading: peersLoading } = useQuery({
    ...listPeersOptions(),
    select: (payload) => payload as unknown as PoolPeer[],
    refetchInterval: 15_000,
  });

  const { data: discoverable, isLoading: discoverableLoading } = useQuery({
    ...listDiscoverableOptions(),
    select: (payload) => payload as unknown as DiscoverablePoolPeer[],
    refetchInterval: 30_000,
  });

  const invalidatePool = () => {
    void queryClient.invalidateQueries({ queryKey: listPeersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: listDiscoverableQueryKey() });
  };

  const pairMutation = useMutation({
    mutationFn: (nodeFqdn: string) => pairPeer({ body: { nodeFqdn } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_PAIR_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_PAIR_ERROR')),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvePeer({ path: { id } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_APPROVE_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_APPROVE_ERROR')),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => rejectPeer({ path: { id } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_REJECT_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_REJECT_ERROR')),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removePeer({ path: { id } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_UNPAIR_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_UNPAIR_ERROR')),
  });

  if (peersLoading || discoverableLoading) {
    return <LoadingCard icon={Network} title={t('HUB_POOL_SECTION_TITLE')} />;
  }

  const pendingInbound = (peers ?? []).filter((p) => p.direction === 'inbound' && p.status === 'pending');
  const pendingOutbound = (peers ?? []).filter((p) => p.direction === 'outbound' && p.status === 'pending');
  const paired = (peers ?? []).filter((p) => p.status === 'connected' || p.status === 'unreachable');

  return (
    <Card data-testid="hub-pool-card">
      <SectionHeader icon={Network} title={t('HUB_POOL_SECTION_TITLE')} description={t('HUB_POOL_SECTION_DESC')} />
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('HUB_POOL_DISCOVERABLE_TITLE')}</h3>
          {discoverable?.length ? (
            <ul className="space-y-2">
              {discoverable.map((device) => (
                <li key={device.tailscaleDeviceId} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  <span className="min-w-0 truncate font-mono text-xs" title={device.nodeFqdn}>
                    {device.hostname}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={demoMode || pairMutation.isPending}
                    loading={pairMutation.isPending && pairMutation.variables === device.nodeFqdn}
                    onClick={() => pairMutation.mutate(device.nodeFqdn)}
                  >
                    {pairMutation.isPending && pairMutation.variables === device.nodeFqdn ? t('HUB_POOL_PAIRING') : t('HUB_POOL_PAIR_BUTTON')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_DISCOVERABLE_EMPTY')}</p>
          )}
        </div>

        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">{t('HUB_POOL_PENDING_TITLE')}</h3>
          {!pendingInbound.length && !pendingOutbound.length ? (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_PENDING_EMPTY')}</p>
          ) : (
            <ul className="space-y-2">
              {pendingInbound.map((peer) => (
                <li key={peer.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  {/* The FQDN, not the display name: approving issues a fresh token to this exact host,
                      and the name is whatever the (unauthenticated) requester chose to call itself. */}
                  <div className="min-w-0">
                    <span className="block truncate font-mono text-xs" title={peer.nodeFqdn} data-testid="hub-pool-pending-fqdn">
                      {peer.nodeFqdn}
                    </span>
                    {peer.displayName ? <span className="block truncate text-xs text-muted-foreground">{peer.displayName}</span> : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={demoMode}
                      loading={rejectMutation.isPending}
                      onClick={() => rejectMutation.mutate(peer.id)}
                    >
                      {t('HUB_POOL_REJECT_BUTTON')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={demoMode}
                      loading={approveMutation.isPending}
                      onClick={() => approveMutation.mutate(peer.id)}
                    >
                      {t('HUB_POOL_APPROVE_BUTTON')}
                    </Button>
                  </div>
                </li>
              ))}
              {pendingOutbound.map((peer) => (
                <li key={peer.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  <span className="min-w-0 truncate font-mono text-xs" title={peer.nodeFqdn}>
                    {peerLabel(peer)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t('HUB_POOL_OUTBOUND_WAITING', { name: peerLabel(peer) })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">{t('HUB_POOL_CONNECTED_TITLE')}</h3>
          {paired.length ? (
            <ul className="space-y-2">
              {paired.map((peer) => (
                <li key={peer.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-xs" title={peer.nodeFqdn}>
                      {peerLabel(peer)}
                    </span>
                    <PoolPeerStatusBadge status={peer.status} t={t} />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    intent="danger"
                    disabled={demoMode}
                    loading={removeMutation.isPending}
                    onClick={() => removeMutation.mutate(peer.id)}
                  >
                    {t('HUB_POOL_UNPAIR_BUTTON')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_CONNECTED_EMPTY')}</p>
          )}
        </div>
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
