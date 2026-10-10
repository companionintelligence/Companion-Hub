import { appContextQueryKey, getHardwareOptions } from '@/api-client/@tanstack/react-query.gen';
import { cloudflareStatusOptions, tailscaleStatusOptions, tailscaleStatusQueryKey } from '@/lib/api-routes/named-status-routes';
import { disconnect } from '@/api-client/sdk.gen';
import type { TailscaleStatusDto } from '@/api-client/types.gen';
import type { HardwareProfile } from '@ci-hub/common/types';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Globe, Monitor, Shield } from 'lucide-react';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { toast } from 'sonner';
import { type CopyOrSelectOutcome, copyOrSelect } from '@/lib/copy-to-clipboard';
import { useTailscaleBrowserAuth } from '@/lib/hooks/use-tailscale-browser-auth';
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
  servePermission?: TailscaleStatusDto['servePermission'];
}

/** How long the copy button shows its result: long enough to read, and for "selected", to press the keys. */
const COPIED_FEEDBACK_MS = 2_000;
const SELECTED_FEEDBACK_MS = 8_000;

/**
 * tailscaled refuses the Hub's Tailscale Serve changes, so no Private VPN app gets published. The
 * reason and the one command that ends it were only in the Hub's log, and every Private VPN app just
 * read "Pending" (CI-Hub#1766). The command is copied through {@link copyOrSelect}: the Hub is often
 * opened over plain http on the LAN, where there is no Clipboard API to copy with.
 */
const ServePermissionRefusal = ({ remedy, deniedSince }: { remedy: string; deniedSince: string | null }) => {
  const { t } = useTranslation();
  const codeRef = useRef<HTMLElement>(null);
  const [outcome, setOutcome] = useState<CopyOrSelectOutcome | null>(null);

  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), outcome === 'copied' ? COPIED_FEEDBACK_MS : SELECTED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const since = deniedSince ? new Date(deniedSince) : null;

  return (
    <div
      className="space-y-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning"
      data-testid="tailscale-serve-refused"
    >
      <p className="font-medium">{t('SETTINGS_NETWORK_TAILSCALE_SERVE_REFUSED')}</p>
      <p>{t('SETTINGS_NETWORK_TAILSCALE_SERVE_REFUSED_DESC')}</p>
      <div className="flex min-w-0 items-start gap-1.5">
        <code
          ref={codeRef}
          className="block min-w-0 flex-1 overflow-x-auto whitespace-pre rounded bg-warning/10 px-2 py-1.5 font-mono"
          data-testid="tailscale-serve-remedy"
        >
          {remedy}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={async () => setOutcome(await copyOrSelect(remedy, codeRef.current))}
          aria-label={t(outcome === 'copied' ? 'SETTINGS_NETWORK_TAILSCALE_SERVE_COMMAND_COPIED' : 'SETTINGS_NETWORK_TAILSCALE_SERVE_COPY_COMMAND')}
          title={t('SETTINGS_NETWORK_TAILSCALE_SERVE_COPY_COMMAND')}
          data-testid="tailscale-serve-remedy-copy"
          className="size-7 shrink-0 text-warning hover:bg-warning/15 hover:text-warning"
        >
          {outcome === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <div role="status" aria-live="polite" className={outcome === 'selected' ? '' : 'sr-only'}>
        {outcome === 'copied'
          ? t('SETTINGS_NETWORK_TAILSCALE_SERVE_COMMAND_COPIED')
          : outcome === 'selected'
            ? t('SETTINGS_NETWORK_TAILSCALE_SERVE_COMMAND_SELECTED')
            : ''}
      </div>
      {since && !Number.isNaN(since.getTime()) && (
        <p className="opacity-80">{t('SETTINGS_NETWORK_TAILSCALE_SERVE_REFUSED_SINCE', { time: since.toLocaleString() })}</p>
      )}
    </div>
  );
};

const TailscaleSidecarSection = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const demoMode = useDemoMode();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    ...tailscaleStatusOptions(),
    select: (payload) => payload as unknown as TailscaleApiStatus,
    refetchInterval: 10_000,
  });

  useTailscaleReadinessSync(data);

  const invalidateTailscaleAndAppContext = () => {
    void queryClient.invalidateQueries({ queryKey: tailscaleStatusQueryKey() });
    void queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
  };

  const browserAuthMutation = useTailscaleBrowserAuth();

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

  if (isError) {
    return (
      <Card data-testid="private-vpn-card">
        <SectionHeader icon={Shield} title={t('SETTINGS_NETWORK_PRIVATE_VPN_TITLE')} />
        <CardContent className="space-y-3">
          <p className="text-sm text-destructive" data-testid="tailscale-status-error">
            {t('SETTINGS_NETWORK_STATUS_ERROR')}
          </p>
          <Button type="button" size="sm" variant="outline" loading={isFetching} onClick={() => refetch()}>
            {t('COMMON_RETRY')}
          </Button>
        </CardContent>
      </Card>
    );
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

        {data?.servePermission?.denied && data.servePermission.remedy && (
          <ServePermissionRefusal remedy={data.servePermission.remedy} deniedSince={data.servePermission.deniedSince} />
        )}
      </CardContent>
    </Card>
  );
};

const CloudflareSection = () => {
  const { t } = useTranslation();

  const {
    data: status,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    ...cloudflareStatusOptions(),
    select: (payload) => payload as unknown as CloudflareStatus,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <LoadingCard icon={Globe} title={t('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')} />;
  }

  if (isError) {
    return (
      <Card data-testid="cloudflare-tunnel-card">
        <SectionHeader icon={Globe} title={t('SETTINGS_NETWORK_CLOUDFLARE_TUNNEL')} />
        <CardContent className="space-y-3">
          <p className="text-sm text-destructive" data-testid="cloudflare-status-error">
            {t('SETTINGS_NETWORK_STATUS_ERROR')}
          </p>
          <Button type="button" size="sm" variant="outline" loading={isFetching} onClick={() => refetch()}>
            {t('COMMON_RETRY')}
          </Button>
        </CardContent>
      </Card>
    );
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

/**
 * On the Docker engine inside WSL, WSL forwards the Hub's ports to this PC's loopback address only,
 * so phones and other computers on the network can't open the Hub or its apps (CI-Hub#1933).
 * Nothing else on this tab would explain why the PC's address doesn't work from them.
 */
const LocalNetworkSection = () => {
  const { t } = useTranslation();
  const { data: containerHostKind } = useQuery({
    ...getHardwareOptions(),
    select: (payload) => (payload as unknown as Partial<HardwareProfile> | null)?.gpu?.containerHostKind,
    retry: false,
  });

  if (containerHostKind !== 'wsl-engine') {
    return null;
  }

  return (
    <Card data-testid="local-network-card">
      <SectionHeader
        icon={Monitor}
        title={t('SETTINGS_NETWORK_LOCAL_TITLE')}
        badge={<StatusBadge connected={false} label={t('SETTINGS_NETWORK_LOCAL_THIS_PC_ONLY')} />}
      />
      <CardContent>
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning">
          {t('SETTINGS_NETWORK_LOCAL_WSL_ENGINE_DESC')}
        </p>
      </CardContent>
    </Card>
  );
};

export const NetworkSettingsContainer = () => (
  <div className="space-y-6" data-testid="network-settings">
    <LocalNetworkSection />
    <TailscaleSidecarSection />
    <HubPoolSection />
    <CloudflareSection />
    <HubAccountSection />
  </div>
);
