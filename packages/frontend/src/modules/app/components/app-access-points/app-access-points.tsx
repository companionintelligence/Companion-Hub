import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card/Card';
import { useAppContext } from '@/context/app-context';
import { openExternal } from '@/lib/helpers/open-external';
import { cn } from '@/lib/utils';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { buildPublicWebIdentity, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { CheckCircle2, Copy, ExternalLink, Globe, Lock, MonitorSmartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

type AccessPointState = 'active' | 'available' | 'unavailable';

export interface AppAccessPoint {
  key: 'public' | 'vpn' | 'local';
  title: string;
  caption: string;
  url: string | null;
  host: string | null;
  state: AccessPointState;
  stateLabel: string;
}

function resolveBrowserHost(internalIp?: string | null): string {
  const trimmed = internalIp?.trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::') {
    return '127.0.0.1';
  }

  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }

  return trimmed;
}

function buildHttpsUrl(hostname: string, sslPort: number, suffix: string): string {
  return `https://${hostname}${sslPort === 443 ? '' : `:${sslPort}`}${suffix}`;
}

function buildTailscalePortHost(nodeFqdn?: string | null, port?: number | null): string | null {
  const cleanNodeFqdn = nodeFqdn?.trim();
  if (!cleanNodeFqdn || !port) {
    return null;
  }

  return `${cleanNodeFqdn}:${port}`;
}

function buildTailscalePortUrl(nodeFqdn?: string | null, port?: number | null, suffix = ''): string | null {
  const host = buildTailscalePortHost(nodeFqdn, port);
  return host ? `https://${host}${suffix}` : null;
}

function hasDirectLocalAccess(record: { exposureMode?: string | null; exposedLocal?: boolean; openPort?: boolean }): boolean {
  return record.exposureMode === 'local' || Boolean(record.exposedLocal) || Boolean(record.openPort);
}

export function buildAppAccessPoints(input: {
  app?: AppDetails | null;
  info: AppInfo;
  sslPort: number;
  internalIp?: string;
  publicDomain?: string;
  cloudflareAvailable: boolean;
  tailscaleAvailable: boolean;
  tailscaleNodeFqdn?: string | null;
  organizationSlug?: string;
  deviceSlug?: string;
}): AppAccessPoint[] {
  const { app, info, sslPort, internalIp, publicDomain, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn, organizationSlug, deviceSlug } =
    input;

  if (!app || info.no_gui) {
    return [];
  }

  const record = app as AppDetails &
    Record<string, unknown> & {
      domain?: string | null;
      exposed?: boolean;
      exposedLocal?: boolean;
      localSubdomain?: string | null;
      openPort?: boolean;
      publicDomain?: string | null;
      exposureMode?: string | null;
    };

  const urlSuffix = info.url_suffix || '';
  const baseSubdomain = record.localSubdomain || info.urn.split(':')[0];
  const cleanSubdomain = baseSubdomain ? sanitizeAppSubdomain(baseSubdomain) : '';
  const browserHost = resolveBrowserHost(internalIp);
  const directPort = app.port ?? info.port ?? null;
  const localEnabled = hasDirectLocalAccess(record);
  const directUrl = directPort && localEnabled ? `${info.https ? 'https' : 'http'}://${browserHost}:${directPort}${urlSuffix}` : null;
  const vpnHost = buildTailscalePortHost(tailscaleNodeFqdn, app.port ?? null);
  const vpnUrl = buildTailscalePortUrl(tailscaleNodeFqdn, app.port ?? null, urlSuffix);

  const configuredPublicDomain = record.domain?.trim() || null;
  const resolvedPublicDomain = (record.publicDomain?.trim() || publicDomain || '').trim();
  const derivedPublicIdentity =
    !configuredPublicDomain && cleanSubdomain && resolvedPublicDomain
      ? buildPublicWebIdentity({
          appSubdomain: cleanSubdomain,
          hubSubdomain: deviceSlug ? `hub-${deviceSlug}${organizationSlug ? `-${organizationSlug}` : ''}` : undefined,
          orgSlug: organizationSlug,
          publicDomainRoot: resolvedPublicDomain,
        })
      : null;
  const publicHost = configuredPublicDomain || derivedPublicIdentity?.hostname || null;
  const publicUrl = publicHost ? buildHttpsUrl(publicHost, sslPort, urlSuffix) : null;

  const localState: AccessPointState = directUrl ? 'active' : 'unavailable';
  const vpnState: AccessPointState =
    vpnUrl && (Boolean(record.exposedLocal) || record.exposureMode === 'tailscale' || !info.dynamic_config)
      ? 'active'
      : tailscaleAvailable && vpnUrl
        ? 'available'
        : 'unavailable';
  const publicState: AccessPointState =
    publicUrl && Boolean(record.exposed || configuredPublicDomain)
      ? 'active'
      : cloudflareAvailable && publicUrl && info.exposable
        ? 'available'
        : 'unavailable';

  return [
    {
      key: 'public',
      title: 'COMMON_PUBLIC_DOMAIN',
      caption: 'APP_DETAILS_ACCESS_PUBLIC_HINT',
      url: info.exposable ? publicUrl : null,
      host: info.exposable ? publicHost : null,
      state: info.exposable ? publicState : 'unavailable',
      stateLabel: info.exposable
        ? publicState === 'active'
          ? 'APP_DETAILS_ACCESS_ENABLED'
          : publicState === 'available'
            ? 'APP_DETAILS_ACCESS_AVAILABLE'
            : 'APP_DETAILS_ACCESS_NOT_CONFIGURED'
        : 'APP_DETAILS_ACCESS_LOCAL_ONLY',
    },
    {
      key: 'vpn',
      title: 'COMMON_PRIVATE_VPN',
      caption: 'APP_DETAILS_ACCESS_VPN_HINT',
      url: vpnUrl,
      host: vpnHost,
      state: vpnState,
      stateLabel:
        vpnState === 'active'
          ? 'APP_DETAILS_ACCESS_ENABLED'
          : vpnState === 'available'
            ? 'APP_DETAILS_ACCESS_AVAILABLE'
            : tailscaleAvailable
              ? 'APP_DETAILS_ACCESS_NOT_CONFIGURED'
              : 'APP_DETAILS_ACCESS_NOT_AVAILABLE',
    },
    {
      key: 'local',
      title: 'APP_DETAILS_ACCESS_LOCAL',
      caption: 'APP_DETAILS_ACCESS_LOCAL_HINT',
      url: directUrl,
      host: directPort && localEnabled ? `${browserHost}:${directPort}` : null,
      state: localState,
      stateLabel: localState === 'active' ? 'APP_DETAILS_ACCESS_ENABLED' : 'APP_DETAILS_ACCESS_NOT_AVAILABLE',
    },
  ];
}

const stateClasses: Record<AccessPointState, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  available: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  unavailable: 'border-border/70 bg-muted/30 text-muted-foreground',
};

interface Props {
  app?: AppDetails | null;
  info: AppInfo;
}

export const AppAccessPoints = ({ app, info }: Props) => {
  const { t } = useTranslation();
  const { userSettings, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn } = useAppContext();

  const accessPoints = buildAppAccessPoints({
    app,
    info,
    sslPort: userSettings.sslPort,
    internalIp: userSettings.internalIp,
    publicDomain: userSettings.domain,
    cloudflareAvailable,
    tailscaleAvailable,
    tailscaleNodeFqdn,
    organizationSlug: userSettings.ciHubOrganizationSlug,
    deviceSlug: userSettings.ciHubDeviceSlug,
  });

  const supportsAccessPanel = Boolean(
    app && !['missing', 'installing', 'install_failed', 'uninstalling', 'backing_up', 'restoring'].includes(app.status),
  );

  if (accessPoints.length === 0 || !supportsAccessPanel) {
    return null;
  }

  const installedApp = app as AppDetails;
  const canOpen = installedApp.status === 'running';

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('SETTINGS_NETWORK_COPIED'));
    } catch {
      toast.error(t('SETTINGS_GENERAL_COPY_FAILED'));
    }
  };

  const iconByKey = {
    public: Globe,
    vpn: Lock,
    local: MonitorSmartphone,
  } as const;

  return (
    <Card className="border-border/60 bg-card/80 shadow-sm">
      <CardHeader className="px-3 pb-3 pt-3 sm:px-6 sm:pb-4 sm:pt-6">
        <CardTitle className="text-lg">{t('APP_DETAILS_ACCESS_TITLE')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-3 pt-0 sm:px-6 sm:pb-6">
        <div className="grid gap-3 lg:grid-cols-3">
          {accessPoints.map((entry) => {
            const Icon = iconByKey[entry.key];

            return (
              <div key={entry.key} className="min-w-0 rounded-xl border border-border/60 bg-muted/20 p-3 sm:p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="mt-0.5 rounded-lg border border-border/60 bg-background/70 p-1.5 sm:p-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium">{t(entry.title)}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{t(entry.caption)}</div>
                    </div>
                  </div>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-[11px] font-medium',
                      stateClasses[entry.state],
                    )}
                  >
                    {entry.state === 'active' ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : null}
                    {t(entry.stateLabel)}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  <div className="min-w-0 rounded-lg border border-border/50 bg-background/60 px-2.5 py-2 sm:px-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('APP_DETAILS_LINK')}</div>
                    <div className="min-w-0 break-all text-sm leading-5">{entry.url || t('COMMON_UNKNOWN')}</div>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => entry.url && openExternal(entry.url)}
                    disabled={!entry.url || !canOpen}
                  >
                    <ExternalLink className="mr-1 h-4 w-4" />
                    {t('APP_ACTION_OPEN')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => entry.url && void copyToClipboard(entry.url)}
                    disabled={!entry.url}
                    title={t('SETTINGS_GENERAL_COPY')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};
