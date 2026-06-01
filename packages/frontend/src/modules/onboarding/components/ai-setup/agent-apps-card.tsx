import { cn } from '@/lib/utils';
import { Globe, Shield } from 'lucide-react';
import type { AgentFramework, RemoteAccessMode } from '../../helpers/ai-setup-types';
import { ONBOARDING_REMOTE_VPN_HINT, ONBOARDING_REMOTE_WEB_HINT } from '@/components/hub-status/hub-status-tooltips';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import { HermesIcon, OpenClawIcon } from './icons';
import { OptionCard, StepSection } from './primitives';

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

const FRAMEWORKS: Array<{ key: AgentFramework; name: string; Icon: typeof OpenClawIcon; description: string }> = [
  {
    key: 'openclaw',
    name: 'OpenClaw',
    Icon: OpenClawIcon,
    description: 'Open source coding & computer-use agent that runs on your Hub.',
  },
  { key: 'hermes', name: 'Hermes', Icon: HermesIcon, description: 'Advanced reasoning assistant for your tools, memory, and notifications.' },
];

const ACCESS_OPTIONS: Array<{ mode: RemoteAccessMode; label: string; transport: string; Icon: typeof Shield }> = [
  { mode: 'tailscale', label: 'Private VPN', transport: 'Tailscale', Icon: Shield },
  { mode: 'cloudflare', label: 'Web', transport: 'Cloudflare', Icon: Globe },
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
  const configured: Record<RemoteAccessMode, boolean> = { tailscale: tailscaleAvailable, cloudflare: cloudflareAvailable };

  return (
    <StepSection number={1} title="Agent Framework" description="Choose one or more agent frameworks to power your system.">
      <div className="space-y-4" data-testid="agent-apps-card">
        <div className="grid gap-4 sm:grid-cols-2">
          {FRAMEWORKS.map(({ key, name, Icon, description }) => (
            <OptionCard
              key={key}
              testId={`agent-${key}`}
              title={name}
              description={description}
              icon={<Icon />}
              selected={frameworks.includes(key)}
              badge={undefined}
              onSelect={() => onToggleFramework(key)}
            />
          ))}
        </div>

        {frameworks.length === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="agent-none-hint">
            No agent selected — you can add one later from the App Store.
          </p>
        )}

        <fieldset className="rounded-2xl border border-border bg-foreground/[0.015] p-4">
          <legend className="px-1 text-xs font-medium">Remote access</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {ACCESS_OPTIONS.map(({ mode, label, transport, Icon }) => {
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
                        <LabelWithHint label={label} hint={ONBOARDING_REMOTE_VPN_HINT} hintId="onboarding-remote-vpn" />
                      ) : (
                        <LabelWithHint label={label} hint={ONBOARDING_REMOTE_WEB_HINT} hintId="onboarding-remote-web" />
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {transport}
                      {!configured[mode] && ' · set up later'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {remoteAccess.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="agent-access-hint">
              Pick one or more remote-access options, or keep your agents on this device only for now.
            </p>
          )}
        </fieldset>
      </div>
    </StepSection>
  );
};
