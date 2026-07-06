import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ExternalLink, Settings, Trash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from 'react-tooltip';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card/Card';
import { useAppContext } from '@/context/app-context';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { openExternal } from '@/lib/helpers/open-external';
import { getServeStatusOptions } from '@/api-client/@tanstack/react-query.gen';
import { buildAppAccessPoints, buildTailscaleServedPortSet } from '@/modules/app/components/app-access-points/app-access-points';
import { UninstallDialog } from '@/modules/app/components/dialogs/uninstall-dialog/uninstall-dialog';
import { PortExposeSettingsDialog } from '@/modules/app/components/port-expose-settings-dialog/port-expose-settings-dialog';
import type { AppDetails, AppInfo } from '@/types/app.types';
import '../containers/app-actions/app-actions.css';

type ExposureMode = 'local' | 'cloudflare' | 'tailscale';

function resolvePortExposeOpenUrl(
  accessPoints: ReturnType<typeof buildAppAccessPoints>,
  exposureMode: ExposureMode | string | null | undefined,
): string | null {
  const priority: Array<'public' | 'vpn' | 'local'> =
    exposureMode === 'cloudflare'
      ? ['public', 'local', 'vpn']
      : exposureMode === 'tailscale'
        ? ['vpn', 'local', 'public']
        : ['local', 'vpn', 'public'];

  for (const key of priority) {
    const point = accessPoints.find((entry) => entry.key === key);
    if (point?.url && (point.state === 'active' || point.state === 'available')) {
      return point.url;
    }
  }

  return accessPoints.find((entry) => entry.url)?.url ?? null;
}

function exposureModeLabel(t: (key: string) => string, exposureMode: ExposureMode | string | null | undefined): string {
  switch (exposureMode) {
    case 'cloudflare':
      return t('APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE');
    case 'tailscale':
      return t('COMMON_PRIVATE_VPN');
    default:
      return t('APP_INSTALL_FORM_EXPOSURE_LOCAL');
  }
}

interface Props {
  app: AppDetails;
  info: AppInfo;
}

export const PortExposeDetailsView = ({ app, info }: Props) => {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { userSettings, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn, tailscaleHttpsEnabled } = useAppContext();

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

  const openUrl = resolvePortExposeOpenUrl(accessPoints, app.exposureMode);
  const logoUrl = getMarketplaceAppImageUrl(info.urn);
  const exposureLabel = exposureModeLabel(t, app.exposureMode);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-0 pb-20 sm:space-y-8">
      <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
        <CardContent className="space-y-4 p-3 sm:space-y-6 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
            <div className="flex shrink-0 justify-start">
              <img
                src={logoUrl}
                alt={info.name}
                className="h-24 w-24 rounded-md bg-white/10 object-cover shadow-lg sm:h-28 sm:w-28 md:h-32 md:w-32"
                onError={(event) => {
                  event.currentTarget.src = '/app-not-found.jpg';
                }}
              />
            </div>

            <div className="min-w-0 flex-1 space-y-3 sm:space-y-4">
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-4xl">{info.name}</h1>
                <p className="text-sm text-muted-foreground sm:text-base">
                  {t('PORT_EXPOSE_DETAILS_SUBTITLE', { port: app.port ?? info.port ?? '—' })} · {exposureLabel}
                </p>
              </div>

              <div data-testid="app-header-actions-row" className={clsx('flex flex-wrap items-start gap-2', 'hero-actions-layout')}>
                <div className="hero-action-bar">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('COMMON_SETTINGS')}
                    title={t('COMMON_SETTINGS')}
                    data-testid="icon-action-settings"
                    data-tooltip-id="port-expose-actions-tooltip"
                    data-tooltip-content={t('COMMON_SETTINGS')}
                    className="hero-action-icon"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings size={16} />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('COMMON_REMOVE')}
                    title={t('COMMON_REMOVE')}
                    data-testid="icon-action-remove"
                    data-tooltip-id="port-expose-actions-tooltip"
                    data-tooltip-content={t('COMMON_REMOVE')}
                    className="hero-action-icon text-destructive hover:text-destructive"
                    onClick={() => setRemoveOpen(true)}
                  >
                    <Trash size={16} />
                  </Button>
                </div>

                <Button
                  data-testid="action-open"
                  size="lg"
                  className="action-button launch-action-button"
                  disabled={!openUrl}
                  onClick={() => openUrl && openExternal(openUrl)}
                >
                  {t('APP_ACTION_OPEN')}
                  <ExternalLink className="ml-1" size={14} role="img" aria-label={t('APP_ACTION_OPEN')} />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tooltip id="port-expose-actions-tooltip" className="tooltip" />

      <PortExposeSettingsDialog app={app} info={info} isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UninstallDialog info={info} isOpen={removeOpen} onClose={() => setRemoveOpen(false)} />
    </div>
  );
};
