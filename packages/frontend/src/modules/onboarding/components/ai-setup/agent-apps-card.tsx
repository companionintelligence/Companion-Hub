import { cn } from '@/lib/utils';
import { ExternalLink, Globe, Shield } from 'lucide-react';
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

interface CompanionAppLink {
  label: string;
  testId: string;
  url: string;
}

const FRAMEWORKS: Array<{
  key: AgentFramework;
  nameKey: string;
  Icon: typeof OpenClawIcon;
  descriptionKey: string;
  companionApps: CompanionAppLink[];
}> = [
  {
    key: 'openclaw',
    nameKey: 'ONBOARDING_AGENT_FRAMEWORK_OPENCLAW',
    Icon: OpenClawIcon,
    descriptionKey: 'ONBOARDING_AGENT_FRAMEWORK_OPENCLAW_DESC',
    companionApps: [
      { label: 'iOS', testId: 'ios', url: 'https://apps.apple.com/us/app/openclaw-ai-that-does-things/id6780396132' },
      { label: 'Android', testId: 'android', url: 'https://play.google.com/store/apps/details?id=ai.openclaw.app' },
      { label: 'Desktop', testId: 'desktop', url: 'https://github.com/openclaw/openclaw/releases' },
    ],
  },
  {
    key: 'hermes',
    nameKey: 'ONBOARDING_AGENT_FRAMEWORK_HERMES',
    Icon: HermesIcon,
    descriptionKey: 'ONBOARDING_AGENT_FRAMEWORK_HERMES_DESC',
    companionApps: [{ label: 'Hermex iOS (separate backend)', testId: 'hermex-for-ios', url: 'https://apps.apple.com/us/app/hermex/id6767006319' }],
  },
];

const ACCESS_OPTIONS: Array<{ mode: RemoteAccessMode; labelKey: string; transportKey: string; Icon: typeof Shield }> = [
  { mode: 'tailscale', labelKey: 'COMMON_PRIVATE_VPN', transportKey: 'ONBOARDING_REMOTE_TRANSPORT_TAILSCALE', Icon: Shield },
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
  const remoteAccessDisabled = frameworks.length === 0;

  return (
    <StepSection number={1} title={t('ONBOARDING_AGENT_FRAMEWORK_TITLE')} description={t('ONBOARDING_AGENT_FRAMEWORK_DESC')}>
      <div className="space-y-4" data-testid="agent-apps-card">
        <div className="grid gap-4 sm:grid-cols-2">
          {FRAMEWORKS.map(({ key, nameKey, Icon, descriptionKey, companionApps }) => (
            <div key={key}>
              <OptionCard
                testId={`agent-${key}`}
                title={t(nameKey)}
                description={t(descriptionKey)}
                icon={<Icon />}
                selected={frameworks.includes(key)}
                badge={undefined}
                onSelect={() => onToggleFramework(key)}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground">
                <span>{t('ONBOARDING_AGENT_COMPANION_APPS')}</span>
                {companionApps.map((app) => (
                  <a
                    key={app.url}
                    href={app.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`${key}-client-${app.testId}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-foreground/[0.02] px-2 py-1 font-medium text-foreground/80 transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    {app.label}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>

        {frameworks.length === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="agent-none-hint">
            {t('ONBOARDING_AGENT_NONE_SELECTED_HINT')}
          </p>
        )}

        <fieldset className={cn('rounded-md border border-border bg-foreground/[0.015] p-4', remoteAccessDisabled && 'opacity-60')}>
          <legend className="px-1 text-xs font-medium">{t('ONBOARDING_REMOTE_ACCESS')}</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {ACCESS_OPTIONS.map(({ mode, labelKey, transportKey, Icon }) => {
              const isSelected = remoteAccess.includes(mode);
              const disabled = remoteAccessDisabled;
              return (
                <label
                  key={mode}
                  className={cn(
                    'flex items-start gap-2 rounded-md border p-2.5 transition-colors',
                    disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
                    isSelected && !disabled ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border hover:bg-muted/50',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => onToggleAccess(mode)}
                    data-testid={`agent-access-${mode}`}
                  />
                  <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {mode === 'tailscale' ? (
                        <LabelWithHint label={t(labelKey)} hint={t(ONBOARDING_REMOTE_VPN_HINT)} hintId="onboarding-remote-vpn" />
                      ) : (
                        <LabelWithHint label={t(labelKey)} hint={t(ONBOARDING_REMOTE_WEB_HINT)} hintId="onboarding-remote-web" />
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
              {remoteAccessDisabled ? t('ONBOARDING_REMOTE_ACCESS_REQUIRES_AGENT') : t('ONBOARDING_REMOTE_ACCESS_HINT')}
            </p>
          )}
        </fieldset>
      </div>
    </StepSection>
  );
};
