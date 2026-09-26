import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { QrCode } from '@/components/ui/qr-code';
import { useAppContext } from '@/context/app-context';
import { getServeStatusOptions } from '@/api-client/@tanstack/react-query.gen';
import { openExternal } from '@/lib/helpers/open-external';
import { cn } from '@/lib/utils';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { buildPublicWebIdentity, normalizeStoredHostname, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { resolveRoutingSubdomain } from '@ci-hub/common/types';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Copy, ExternalLink, Globe, Lock, MonitorSmartphone, QrCode as QrCodeIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '::', '[::1]', '[::]']);

function parseAccessUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether a URL resolves to this machine and nothing else.
 *
 * `resolveBrowserHost` above deliberately falls back to `127.0.0.1` when the
 * appliance has not reported an internal IP, which is right for a link the
 * local browser follows but wrong for anything handed to another device: the
 * backend's `buildHubLocalOrigin` returns null for the same case rather than
 * publish a loopback origin. A QR is only ever scanned by another device, so a
 * loopback address in one is guaranteed to fail — the card offers no code for it.
 */
export function isLoopbackAccessUrl(url: string | null): boolean {
  if (!url) {
    return false;
  }

  const parsed = parseAccessUrl(url);
  if (!parsed) {
    // An unparseable URL is not something we should offer to another device either.
    return true;
  }

  return LOOPBACK_HOSTS.has(parsed.hostname) || parsed.hostname.startsWith('127.');
}

/**
 * Whether a URL is not a URL at all.
 *
 * `isLoopbackAccessUrl` folds this case into its `true` answer so the QR button
 * stays fail-closed, which is the right call for the *behaviour*. It is the
 * wrong call for the *copy*: telling someone a garbled address "only works on
 * this machine" is a specific factual claim, and it is false — nothing is known
 * about where that address points, including whether it points anywhere. The
 * card asks this first so the two failures can say different things.
 */
export function isMalformedAccessUrl(url: string | null): boolean {
  return url ? parseAccessUrl(url) === null : false;
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  // `*.localhost` resolves to loopback in browsers (RFC 6761), and the Tauri desktop
  // shell serves from `tauri.localhost` on Windows.
  return LOOPBACK_HOSTS.has(lower) || lower.startsWith('127.') || lower === 'localhost' || lower.endsWith('.localhost');
}

function currentViewerHostname(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.hostname;
}

/**
 * The Hub address a Local access link should name, as seen from the browser showing it.
 *
 * When the Hub reports no LAN address, or a listen-all or loopback one, `127.0.0.1` is
 * right only for a browser on the Hub. From another machine (a tailnet name, a LAN IP)
 * it is the viewer's own computer, while the hostname that browser used to reach the
 * dashboard is one it can reach. A browser on the public hostname keeps the reported
 * value: the Cloudflare tunnel carries 443 only, so `<that name>:<port>` cannot connect.
 */
export function resolveReachableHubHost(input: {
  internalIp?: string | null;
  viewerHostname?: string | null;
  publicDomain?: string | null;
}): string | undefined {
  const reported = input.internalIp?.trim() || undefined;
  if (reported && !isLoopbackHost(reported) && reported !== '0.0.0.0' && reported !== '::') {
    return reported;
  }

  const viewer = input.viewerHostname?.trim().toLowerCase().replace(/\.+$/, '');
  if (!viewer || isLoopbackHost(viewer)) {
    return reported;
  }

  const publicDomain = input.publicDomain?.trim().toLowerCase().replace(/\.+$/, '');
  if (publicDomain && (viewer === publicDomain || viewer.endsWith(`.${publicDomain}`))) {
    return reported;
  }

  return viewer;
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

export function buildTailscaleServedPortSet(entries: Array<{ listenPort?: number }>): ReadonlySet<number> {
  return new Set(entries.map((entry) => entry.listenPort).filter((port): port is number => typeof port === 'number'));
}

export function isTailscalePortPublished(port: number | null | undefined, servedPorts: ReadonlySet<number>): boolean {
  return port != null && servedPorts.has(port);
}

function hasDirectLocalAccess(
  record: { exposureMode?: string | null; exposedLocal?: boolean; openPort?: boolean },
  options: { hasHostPort: boolean; dynamicConfig: boolean },
): boolean {
  if (!options.hasHostPort) return false;

  const mode = record.exposureMode;
  // Tailscale-only installs may skip publishing a host port unless explicitly requested.
  if (mode === 'tailscale') return Boolean(record.openPort);
  // Public-web and local installs still bind the app port on the host — localhost stays valid.
  if (mode === 'cloudflare' || mode === 'local') return true;

  // Pre-exposureMode installs: match guest-dashboard heuristics.
  return Boolean(record.openPort) || Boolean(record.exposedLocal) || !options.dynamicConfig;
}

function getEffectiveExposureMode(record: { exposureMode?: string | null; exposedLocal?: boolean }): 'local' | 'cloudflare' | 'tailscale' {
  if (record.exposureMode === 'local' || record.exposureMode === 'cloudflare' || record.exposureMode === 'tailscale') {
    return record.exposureMode;
  }

  return record.exposedLocal ? 'cloudflare' : 'local';
}

function publishesPublicWebAccess(record: { exposureMode?: string | null; exposedLocal?: boolean }): boolean {
  return getEffectiveExposureMode(record) === 'cloudflare' || Boolean(record.exposedLocal);
}

export function buildAppAccessPoints(input: {
  app?: AppDetails | null;
  info: AppInfo;
  sslPort: number;
  internalIp?: string;
  /** Hostname the browser reached the Hub on; defaults to `window.location.hostname`. */
  viewerHostname?: string | null;
  publicDomain?: string;
  cloudflareAvailable: boolean;
  tailscaleAvailable: boolean;
  tailscaleNodeFqdn?: string | null;
  tailscaleHttpsEnabled?: boolean;
  tailscaleServedPorts?: ReadonlySet<number>;
  organizationSlug?: string;
  deviceSlug?: string;
  hubSubdomain?: string | null;
}): AppAccessPoint[] {
  const {
    app,
    info,
    sslPort,
    internalIp: reportedInternalIp,
    viewerHostname = currentViewerHostname(),
    publicDomain,
    cloudflareAvailable,
    tailscaleAvailable,
    tailscaleNodeFqdn,
    tailscaleHttpsEnabled = false,
    tailscaleServedPorts = new Set<number>(),
    organizationSlug,
    deviceSlug,
    hubSubdomain,
  } = input;

  if (!app || info.no_gui) {
    return [];
  }

  const internalIp = resolveReachableHubHost({ internalIp: reportedInternalIp, viewerHostname, publicDomain });

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
  const [urnAppName = '', urnAppStoreSlug = ''] = info.urn.split(':');
  // The label Portal serves: `<app>-<store>` when no subdomain was chosen. The bare app name
  // linked every app installed without one (API, MCP, restore) to a hostname that does not resolve.
  const baseSubdomain = urnAppStoreSlug
    ? resolveRoutingSubdomain(record.localSubdomain, urnAppName, urnAppStoreSlug)
    : record.localSubdomain || urnAppName;
  const cleanSubdomain = baseSubdomain ? sanitizeAppSubdomain(baseSubdomain) : '';
  const browserHost = resolveBrowserHost(internalIp);
  const directPort = app.port ?? info.port ?? null;
  const localEnabled = hasDirectLocalAccess(record, { hasHostPort: directPort != null, dynamicConfig: info.dynamic_config });
  const directScheme = info.https ? 'https' : 'http';
  const directUrl = directPort && localEnabled ? `${directScheme}://${browserHost}:${directPort}${urlSuffix}` : null;
  const vpnHost = buildTailscalePortHost(tailscaleNodeFqdn, directPort);
  const vpnUrl = buildTailscalePortUrl(tailscaleNodeFqdn, directPort, urlSuffix);

  const configuredPublicDomain = record.domain?.trim() || null;
  const resolvedPublicDomain = (record.publicDomain?.trim() || publicDomain || '').trim();
  const resolvedHubSubdomain = hubSubdomain?.trim() || (deviceSlug && organizationSlug ? `hub-${deviceSlug}-${organizationSlug}` : undefined);
  const derivedPublicIdentity =
    !configuredPublicDomain && cleanSubdomain && resolvedPublicDomain
      ? buildPublicWebIdentity({
          appSubdomain: cleanSubdomain,
          hubSubdomain: resolvedHubSubdomain,
          orgSlug: organizationSlug,
          publicDomainRoot: resolvedPublicDomain,
        })
      : null;
  // A custom hostname Companion Portal has actually wired for this app is the address the
  // user visits, so it is the one this card links to and shows in its QR code.
  const syncedCustomDomain = normalizeStoredHostname(record.customDomain);
  const publicHost = syncedCustomDomain || configuredPublicDomain || derivedPublicIdentity?.hostname || null;
  // `sslPort` is the HUB's own local HTTPS port. A custom hostname is terminated by
  // Cloudflare, which only answers on 443, so appending the local port to it would
  // link and QR-code an address that cannot connect — and would disagree with the
  // backend probe, which requests the same hostname on 443 and reports it healthy.
  const publicUrl = publicHost ? buildHttpsUrl(publicHost, syncedCustomDomain ? 443 : sslPort, urlSuffix) : null;

  const expectsTailscalePublish = record.exposureMode === 'tailscale';
  // Legacy (pre-exposureMode) installs may still infer VPN from older flags.
  const legacyVpnActive = !record.exposureMode && (Boolean(record.exposedLocal) || !info.dynamic_config);
  const vpnPortPublished = isTailscalePortPublished(directPort, tailscaleServedPorts);
  const tailscalePublishReady = tailscaleAvailable && tailscaleHttpsEnabled && vpnPortPublished;

  const localState: AccessPointState = directUrl ? 'active' : 'unavailable';
  const vpnState: AccessPointState = vpnUrl
    ? tailscalePublishReady && (expectsTailscalePublish || legacyVpnActive)
      ? 'active'
      : tailscaleAvailable
        ? 'available'
        : 'unavailable'
    : 'unavailable';
  const publicWebConfigured = publishesPublicWebAccess(record) || Boolean(configuredPublicDomain) || Boolean(record.exposed);
  const publicActive = Boolean(publicUrl && publicWebConfigured);
  const publicState: AccessPointState = publicActive ? 'active' : cloudflareAvailable && publicUrl && info.exposable ? 'available' : 'unavailable';

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
          : vpnState === 'available' && expectsTailscalePublish && !vpnPortPublished
            ? 'APP_DETAILS_ACCESS_PENDING'
            : vpnState === 'available' && expectsTailscalePublish
              ? 'APP_DETAILS_ACCESS_NOT_CONFIGURED'
              : vpnState === 'available'
                ? 'APP_DETAILS_ACCESS_NOT_CONFIGURED'
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
  active: 'border-success/30 bg-success/10 text-success',
  // `available`/`pending` describe a route you *could* turn on, not one that is
  // currently serving the app — render them neutral (not a positive amber) so
  // the badge can't be misread as "this URL is live".
  available: 'border-border/70 bg-muted/30 text-muted-foreground',
  unavailable: 'border-border/70 bg-muted/30 text-muted-foreground',
};

interface Props {
  app?: AppDetails | null;
  info: AppInfo;
}

export const AppAccessPoints = ({ app, info }: Props) => {
  const { t } = useTranslation();
  const { userSettings, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn, tailscaleHttpsEnabled } = useAppContext();
  const [qrEntry, setQrEntry] = useState<AppAccessPoint | null>(null);

  const { data: serveStatus } = useQuery({
    ...getServeStatusOptions(),
    select: (payload) => payload as { entries: Array<{ listenPort?: number }> },
    enabled: tailscaleAvailable,
    refetchInterval: 30_000,
  });

  const tailscaleServedPorts = useMemo(() => buildTailscaleServedPortSet(serveStatus?.entries ?? []), [serveStatus?.entries]);

  const accessPoints = buildAppAccessPoints({
    app,
    info,
    sslPort: userSettings.sslPort,
    internalIp: userSettings.internalIp,
    publicDomain: userSettings.domain,
    cloudflareAvailable,
    tailscaleAvailable,
    tailscaleNodeFqdn,
    tailscaleHttpsEnabled,
    tailscaleServedPorts,
    organizationSlug: userSettings.ciHubOrganizationSlug,
    deviceSlug: userSettings.ciHubDeviceSlug,
    hubSubdomain: userSettings.ciHubHubSubdomain,
  });

  const supportsAccessPanel = Boolean(app && !['installing', 'install_failed', 'uninstalling', 'backing_up', 'restoring'].includes(app.status));

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
            // Only a route that is actually serving the app gets a live link +
            // working buttons. `available`/`pending`/`unavailable` are routes
            // you could enable but that don't resolve yet, so we hide the URL
            // and disable Open/Copy rather than offer a dead link.
            const isActive = entry.state === 'active';
            // Open and Copy both land on this device. A QR is the off-device route —
            // which is exactly why a loopback address must not get one.
            const isLoopback = isLoopbackAccessUrl(entry.url);
            // A subset of the above: `isLoopback` is also true for an address we
            // could not parse, and that case needs its own explanation.
            const isMalformed = isMalformedAccessUrl(entry.url);
            const canShare = isActive && Boolean(entry.url) && !isLoopback;

            return (
              <div key={entry.key} className="min-w-0 rounded-md border border-border/60 bg-muted/20 p-3 sm:p-4">
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
                    <div className={cn('min-w-0 break-all text-sm leading-5', !isActive && 'text-muted-foreground')}>
                      {isActive && entry.url ? entry.url : t(entry.stateLabel)}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => isActive && entry.url && openExternal(entry.url)}
                    disabled={!isActive || !entry.url || !canOpen}
                  >
                    <ExternalLink className="mr-1 h-4 w-4" />
                    {t('APP_ACTION_OPEN')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => isActive && entry.url && void copyToClipboard(entry.url)}
                    disabled={!isActive || !entry.url}
                    title={t('SETTINGS_GENERAL_COPY')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => canShare && setQrEntry(entry)}
                    disabled={!canShare}
                    title={
                      isActive && isMalformed
                        ? t('APP_DETAILS_ACCESS_QR_MALFORMED')
                        : isActive && isLoopback
                          ? t('APP_DETAILS_ACCESS_QR_LOOPBACK')
                          : t('APP_DETAILS_ACCESS_SHOW_QR')
                    }
                    aria-label={t('APP_DETAILS_ACCESS_SHOW_QR')}
                  >
                    <QrCodeIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>

      <Dialog open={qrEntry !== null} onOpenChange={(open: boolean) => !open && setQrEntry(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{qrEntry ? t(qrEntry.title) : t('APP_DETAILS_ACCESS_SHOW_QR')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="flex flex-col">
            {qrEntry?.url ? <QrCode value={qrEntry.url} fallback={qrEntry.url} mark caption={t('APP_DETAILS_ACCESS_QR_HINT')} /> : null}
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
