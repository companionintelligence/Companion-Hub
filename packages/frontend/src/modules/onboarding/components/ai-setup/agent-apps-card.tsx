import { cn } from '@/lib/utils';
import type { CuratedModel } from '@ci-hub/common/types';
import { Globe, Shield } from 'lucide-react';
import type { AgentFramework, ExposureMode } from '../../helpers/ai-setup-types';
import { HermesIcon, OpenClawIcon } from './icons';
import { OptionCard, StepSection } from './primitives';

interface AgentFrameworkCardProps {
  /** Currently selected agent framework, or undefined when the user wants no agent. */
  framework?: AgentFramework;
  /** Receives the picked framework, or undefined when the current selection is toggled off. */
  onSelectFramework: (framework: AgentFramework | undefined) => void;
  /** LLM candidates (for the selected backend) the agent can default to. */
  models: CuratedModel[];
  /** Currently selected preferred model id, if any. */
  preferredModelId: string | undefined;
  onSelectPreferred: (modelId: string) => void;
  /** Preferred remote-access transport for the agent. */
  exposureMode: ExposureMode;
  onSelectExposureMode: (mode: ExposureMode) => void;
  cloudflareAvailable?: boolean;
  tailscaleAvailable?: boolean;
}

const FRAMEWORKS: Array<{ key: AgentFramework; name: string; Icon: typeof OpenClawIcon; description: string; recommended?: boolean }> = [
  {
    key: 'openclaw',
    name: 'OpenClaw',
    Icon: OpenClawIcon,
    description: 'Open source coding & computer-use agent that runs on your Hub.',
    recommended: true,
  },
  { key: 'hermes', name: 'Hermes', Icon: HermesIcon, description: 'Advanced reasoning assistant for your tools, memory, and notifications.' },
];

const ACCESS_OPTIONS: Array<{ mode: Exclude<ExposureMode, 'local'>; label: string; transport: string; Icon: typeof Shield }> = [
  { mode: 'tailscale', label: 'Private VPN', transport: 'Tailscale', Icon: Shield },
  { mode: 'cloudflare', label: 'Web', transport: 'Cloudflare', Icon: Globe },
];

// Used only by the (hidden) default-model picker.
// function formatSize(mb: number): string {
//   if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
//   return `${mb} MB`;
// }

/**
 * Step 1 — Agent Framework. Prominently features OpenClaw (default) and Hermes as the two personal
 * AI agents, and folds in the model the chosen agent defaults to plus how it's reached remotely
 * (private Tailscale VPN or a public Cloudflare web URL).
 */
export const AgentFrameworkCard = ({
  framework,
  onSelectFramework,
  // Default-model picker hidden — restore these with the picker block below.
  // models,
  // preferredModelId,
  // onSelectPreferred,
  exposureMode,
  onSelectExposureMode,
  cloudflareAvailable = false,
  tailscaleAvailable = false,
}: AgentFrameworkCardProps) => {
  // const hasModels = models.length > 0;
  const configured: Record<Exclude<ExposureMode, 'local'>, boolean> = { tailscale: tailscaleAvailable, cloudflare: cloudflareAvailable };

  return (
    <StepSection number={1} title="Agent Framework" description="Choose the agent framework to power your system, or skip it for now.">
      <div className="space-y-4" data-testid="agent-apps-card">
        <div className="grid gap-4 sm:grid-cols-2">
          {FRAMEWORKS.map(({ key, name, Icon, description, recommended }) => (
            <OptionCard
              key={key}
              testId={`agent-${key}`}
              title={name}
              description={description}
              icon={<Icon />}
              selected={framework === key}
              badge={recommended ? 'Recommended' : undefined}
              // Re-selecting the active framework toggles it off so no agent is installed.
              onSelect={() => onSelectFramework(framework === key ? undefined : key)}
            />
          ))}
        </div>

        {!framework && (
          <p className="text-xs text-muted-foreground" data-testid="agent-none-hint">
            No agent selected — you can add one later from the App Store.
          </p>
        )}

        <div className="rounded-2xl border border-border bg-foreground/[0.015] p-4">
          {/* Default model picker hidden — the agent automatically uses the first selected recommended model.
          <div>
            <label className="text-xs font-medium" htmlFor="preferred-model-select">
              Default model
            </label>
            {hasModels ? (
              <>
                <select
                  id="preferred-model-select"
                  data-testid="preferred-model-select"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={preferredModelId ?? ''}
                  onChange={(e) => onSelectPreferred(e.target.value)}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName} · {formatSize(model.runtime.memoryFootprintMb)}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">Your agent and the Hub default to this model. Change it later in Settings.</p>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="preferred-model-empty">
                Select a local language model below and your agent will use it automatically.
              </p>
            )}
          </div>
          */}

          <div>
            <span className="text-xs font-medium">Remote access</span>
            <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Remote access for your agent">
              {ACCESS_OPTIONS.map(({ mode, label, transport, Icon }) => {
                const isSelected = exposureMode === mode;
                return (
                  <label
                    key={mode}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors',
                      isSelected ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <input
                      type="radio"
                      name="agent-remote-access"
                      className="sr-only"
                      checked={isSelected}
                      onChange={() => onSelectExposureMode(mode)}
                      data-testid={`agent-access-${mode}`}
                    />
                    <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {transport}
                        {!configured[mode] && ' · set up later'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {exposureMode === 'local' && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="agent-access-hint">
                Pick a remote-access option, or keep your agent on this device only for now.
              </p>
            )}
          </div>
        </div>
      </div>
    </StepSection>
  );
};
