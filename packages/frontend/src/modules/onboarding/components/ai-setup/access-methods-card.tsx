import { cn } from '@/lib/utils';
import { Globe, Monitor, Shield } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RemoteAccessMode } from '../../helpers/ai-setup-types';
import { ONBOARDING_REMOTE_VPN_HINT, ONBOARDING_REMOTE_WEB_HINT } from '@/components/hub-status/hub-status-tooltips';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import { StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

interface AccessMethodsCardProps {
  remoteAccess: RemoteAccessMode[];
  onToggleAccess: (mode: RemoteAccessMode) => void;
  cloudflareAvailable?: boolean;
  tailscaleAvailable?: boolean;
  /** Inline Tailscale setup panel rendered when VPN is selected. */
  tailscaleSetup?: ReactNode;
}

const REMOTE_OPTIONS: Array<{ mode: RemoteAccessMode; labelKey: string; descKey: string; Icon: typeof Shield }> = [
  { mode: 'tailscale', labelKey: 'COMMON_PRIVATE_VPN', descKey: 'ONBOARDING_ACCESS_VPN_DESC', Icon: Shield },
  { mode: 'cloudflare', labelKey: 'ONBOARDING_REMOTE_WEB', descKey: 'ONBOARDING_ACCESS_WEB_DESC', Icon: Globe },
];

/**
 * Step 2 — Access Methods. Choose how to reach the Hub: this computer (default),
 * private VPN (Tailscale), and/or public web (Cloudflare).
 */
export const AccessMethodsCard = ({
  remoteAccess,
  onToggleAccess,
  cloudflareAvailable = false,
  tailscaleAvailable = false,
  tailscaleSetup,
}: AccessMethodsCardProps) => {
  const { t } = useTranslation();
  const configured: Record<RemoteAccessMode, boolean> = { tailscale: tailscaleAvailable, cloudflare: cloudflareAvailable };
  const localOnly = remoteAccess.length === 0;

  return (
    <StepSection number={2} badge="optional" title={t('ONBOARDING_ACCESS_METHODS_TITLE')} description={t('ONBOARDING_ACCESS_METHODS_DESC')}>
      <div className="space-y-4" data-testid="access-methods-card">
        <div className="grid gap-2 sm:grid-cols-3">
          <div
            className={cn(
              'flex items-start gap-2 rounded-md border p-2.5',
              localOnly ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border bg-foreground/[0.015]',
            )}
            data-testid="access-this-computer"
          >
            <Monitor className={cn('mt-0.5 h-4 w-4 shrink-0', localOnly ? 'text-primary' : 'text-muted-foreground')} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t('ONBOARDING_ACCESS_THIS_COMPUTER')}</span>
              <span className="block text-xs text-muted-foreground">{t('ONBOARDING_ACCESS_THIS_COMPUTER_DESC')}</span>
            </span>
          </div>

          {REMOTE_OPTIONS.map(({ mode, labelKey, descKey, Icon }) => {
            const isSelected = remoteAccess.includes(mode);
            return (
              <label
                key={mode}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md border p-2.5 transition-colors',
                  isSelected ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border hover:bg-muted/50',
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={isSelected}
                  onChange={() => onToggleAccess(mode)}
                  data-testid={`access-${mode}`}
                />
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {mode === 'tailscale' ? (
                      <LabelWithHint label={t(labelKey)} hint={t(ONBOARDING_REMOTE_VPN_HINT)} hintId="onboarding-access-vpn" />
                    ) : (
                      <LabelWithHint label={t(labelKey)} hint={t(ONBOARDING_REMOTE_WEB_HINT)} hintId="onboarding-access-web" />
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(descKey)}
                    {!configured[mode] && ` ${t('ONBOARDING_REMOTE_SET_UP_LATER_SUFFIX')}`}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {tailscaleSetup}
      </div>
    </StepSection>
  );
};
