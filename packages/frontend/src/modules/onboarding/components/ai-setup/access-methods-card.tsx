import { cn } from '@/lib/utils';
import { Globe, Shield } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RemoteAccessMode } from '../../helpers/ai-setup-types';
import { ONBOARDING_REMOTE_VPN_HINT, ONBOARDING_REMOTE_WEB_HINT } from '@/components/hub-status/hub-status-tooltips';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import { SelectIndicator, StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

interface AccessMethodsCardProps {
  remoteAccess: RemoteAccessMode[];
  onToggleAccess: (mode: RemoteAccessMode) => void;
  cloudflareAvailable?: boolean;
  tailscaleAvailable?: boolean;
  /** Inline Tailscale setup panel rendered when VPN is selected. */
  tailscaleSetup?: ReactNode;
}

/**
 * Step 1 — How to access your Hub.
 * Web is the default path; Private VPN is an optional add-on with inline Tailscale connect.
 * Local access on this computer is always available and is not presented as a competing mode.
 */
export const AccessMethodsCard = ({
  remoteAccess,
  onToggleAccess,
  cloudflareAvailable = false,
  tailscaleAvailable = false,
  tailscaleSetup,
}: AccessMethodsCardProps) => {
  const { t } = useTranslation();
  const webSelected = remoteAccess.includes('cloudflare');
  const vpnSelected = remoteAccess.includes('tailscale');
  const localOnly = remoteAccess.length === 0;

  return (
    <StepSection number={1} badge="recommended" title={t('ONBOARDING_ACCESS_METHODS_TITLE')} description={t('ONBOARDING_ACCESS_METHODS_DESC')}>
      <div className="space-y-4" data-testid="access-methods-card">
        <label
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-md border p-4 transition-colors',
            webSelected ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/30' : 'border-border hover:border-primary/40 hover:bg-muted/40',
          )}
        >
          <input
            type="checkbox"
            className="sr-only"
            checked={webSelected}
            onChange={() => onToggleAccess('cloudflare')}
            data-testid="access-cloudflare"
          />
          <Globe className={cn('mt-0.5 h-5 w-5 shrink-0', webSelected ? 'text-primary' : 'text-muted-foreground')} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold">
                <LabelWithHint label={t('ONBOARDING_ACCESS_WEB_TITLE')} hint={t(ONBOARDING_REMOTE_WEB_HINT)} hintId="onboarding-access-web" />
              </span>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                {t('ONBOARDING_ACCESS_WEB_RECOMMENDED')}
              </span>
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t('ONBOARDING_ACCESS_WEB_DESC')}
              {!cloudflareAvailable && ` ${t('ONBOARDING_REMOTE_SET_UP_LATER_SUFFIX')}`}
            </span>
          </span>
          <SelectIndicator selected={webSelected} className="mt-0.5" />
        </label>

        <div className="space-y-3">
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md border p-4 transition-colors',
              vpnSelected ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/30' : 'border-border hover:border-primary/40 hover:bg-muted/40',
            )}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={vpnSelected}
              onChange={() => onToggleAccess('tailscale')}
              data-testid="access-tailscale"
            />
            <Shield className={cn('mt-0.5 h-5 w-5 shrink-0', vpnSelected ? 'text-primary' : 'text-muted-foreground')} />
            <span className="min-w-0 flex-1">
              <span className="text-base font-semibold">
                <LabelWithHint label={t('ONBOARDING_ACCESS_VPN_TITLE')} hint={t(ONBOARDING_REMOTE_VPN_HINT)} hintId="onboarding-access-vpn" />
              </span>
              {vpnSelected && !tailscaleAvailable && (
                <span className="mt-1 block text-sm text-muted-foreground">{t('ONBOARDING_ACCESS_VPN_CONNECT_BELOW')}</span>
              )}
            </span>
            <SelectIndicator selected={vpnSelected} className="mt-0.5" />
          </label>

          {tailscaleSetup}
        </div>

        {localOnly && (
          <p className="text-sm text-muted-foreground" data-testid="access-local-baseline">
            {t('ONBOARDING_ACCESS_LOCAL_ONLY_NOTE')}
          </p>
        )}
      </div>
    </StepSection>
  );
};
