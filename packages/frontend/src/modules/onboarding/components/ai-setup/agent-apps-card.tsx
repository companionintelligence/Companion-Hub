import { ExternalLink } from 'lucide-react';
import type { AgentFramework } from '../../helpers/ai-setup-types';
import { HermesIcon, OpenClawIcon } from './icons';
import { OptionCard, StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

interface AgentFrameworkCardProps {
  /** Currently selected agent frameworks (one or more). */
  frameworks: AgentFramework[];
  onToggleFramework: (framework: AgentFramework) => void;
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

/**
 * Step 1 — Choose your AI agent. Pick one or more personal AI agents (OpenClaw, Hermes).
 */
export const AgentFrameworkCard = ({ frameworks, onToggleFramework }: AgentFrameworkCardProps) => {
  const { t } = useTranslation();

  return (
    <StepSection number={1} badge="recommended" title={t('ONBOARDING_AGENT_FRAMEWORK_TITLE')} description={t('ONBOARDING_AGENT_FRAMEWORK_DESC')}>
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
      </div>
    </StepSection>
  );
};
