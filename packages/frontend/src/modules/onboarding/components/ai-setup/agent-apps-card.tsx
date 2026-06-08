import { cn } from '@/lib/utils';
import { Globe, Shield } from 'lucide-react';
import type { AgentFramework, RemoteAccessMode } from '../../helpers/ai-setup-types';
import { ONBOARDING_REMOTE_VPN_HINT, ONBOARDING_REMOTE_WEB_HINT } from '@/components/hub-status/hub-status-tooltips';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import { HermesIcon, OpenClawIcon } from './icons';
import { OptionCard, StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

interface AgentFrameworkCardProps {
  /** Currently selected agent frameworks (one or more). */
  frameworks: AgentFramework[];
  onToggleFramework: (framework: AgentFramework) => void;
  /** Remote-access transports the user has enabled (zero or more). */
  remoteAccess: RemoteAccessMode[];
  onToggleAccess: (mode: RemoteAccessMode) => void;
  cloudflareAvailable?: boolean;
  tailscaleAvailable?: boolean;
}

const FRAMEWORKS: Array<{ key: AgentFramework; nameKey: string; Icon: typeof OpenClawIcon; descriptionKey: string }> = [
  {
    key: 'openclaw',
    nameKey: 'ONBOARDING_AGENT_FRAMEWORK_OPENCLAW',
    Icon: OpenClawIcon,
    descriptionKey: 'ONBOARDING_AGENT_FRAMEWORK_OPENCLAW_DESC',
  },
  {
    key: 'hermes',
    nameKey: 'ONBOARDING_AGENT_FRAMEWORK_HERMES',
    Icon: HermesIcon,
    descriptionKey: 'ONBOARDING_AGENT_FRAMEWORK_HERMES_DESC',
  },
];

const ACCESS_OPTIONS: Array<{ mode: RemoteAccessMode; labelKey: string; transportKey: string; Icon: typeof Shield }> = [
  { mode: 'tailscale', labelKey: 'ONBOARDING_REMOTE_PRIVATE_VPN', transportKey: 'ONBOARDING_REMOTE_TRANSPORT_TAILSCALE', Icon: Shield },
  { mode: 'cloudflare', labelKey: 'ONBOARDING_REMOTE_WEB', transportKey: 'ONBOARDING_REMOTE_TRANSPORT_CLOUDFLARE', Icon: Globe },
];

/**
 * Step 1 — Agent Framework. Pick one or more personal AI agents (OpenClaw, Hermes) and one or more
 * remote-access transports (private Tailscale VPN and/or a public Cloudflare web URL) that apply to
 * whichever agents you selected. Both are multi-select; remote access is optional (local-only).
 */
export const AgentFrameworkCard = ({
  frameworks,
  onToggleFramework,
  remoteAccess,
  onToggleAccess,
  cloudflareAvailable = false,
  tailscaleAvailable = false,
}: AgentFrameworkCardProps) => {
  const { t } = useTranslation();
  const configured: Record<RemoteAccessMode, boolean> = { tailscale: tailscaleAvailable, cloudflare: cloudflareAvailable };

  return (
    <StepSection number={1} title={t('ONBOARDING_AGENT_FRAMEWORK_TITLE')} description={t('ONBOARDING_AGENT_FRAMEWORK_DESC')}>
      <div className="space-y-4" data-testid="agent-apps-card">
        <div className="grid gap-4 sm:grid-cols-2">
          {FRAMEWORKS.map(({ key, nameKey, Icon, descriptionKey }) => (
            <OptionCard
              key={key}
              testId={`agent-${key}`}
              title={t(nameKey)}
              description={t(descriptionKey)}
              icon={<Icon />}
              selected={frameworks.includes(key)}
              badge={undefined}
              onSelect={() => onToggleFramework(key)}
            />
          ))}
        </div>

        {frameworks.length === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="agent-none-hint">
            {t('ONBOARDING_AGENT_NONE_SELECTED_HINT')}
          </p>
        )}

        <fieldset className="rounded-2xl border border-border bg-foreground/[0.015] p-4">
          <legend className="px-1 text-xs font-medium">{t('ONBOARDING_REMOTE_ACCESS')}</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {ACCESS_OPTIONS.map(({ mode, labelKey, transportKey, Icon }) => {
              const isSelected = remoteAccess.includes(mode);
              return (
                <label
                  key={mode}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors',
                    isSelected ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border hover:bg-muted/50',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={isSelected}
                    onChange={() => onToggleAccess(mode)}
                    data-testid={`agent-access-${mode}`}
                  />
                  <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {mode === 'tailscale' ? (
                        <LabelWithHint label={t(labelKey)} hint={ONBOARDING_REMOTE_VPN_HINT} hintId="onboarding-remote-vpn" />
                      ) : (
                        <LabelWithHint label={t(labelKey)} hint={ONBOARDING_REMOTE_WEB_HINT} hintId="onboarding-remote-web" />
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(transportKey)}
                      {!configured[mode] && ` ${t('ONBOARDING_REMOTE_SET_UP_LATER_SUFFIX')}`}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {remoteAccess.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="agent-access-hint">
              {t('ONBOARDING_REMOTE_ACCESS_HINT')}
            </p>
          )}
        </fieldset>
      </div>
    </StepSection>
  );
};
