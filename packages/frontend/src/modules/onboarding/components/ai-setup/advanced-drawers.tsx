import { cn } from '@/lib/utils';
import type { CuratedModel } from '@ci-hub/common/types';
import { ChevronDown, ChevronRight, Cloud } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { CloudProviderInput } from '../../helpers/ai-setup-types';
import { CloudProviderCard } from './cloud-provider-card';
import { CubeModelsIcon } from './icons';
import { OtherModels } from './model-selection-card';

interface AdvancedDrawersProps {
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  selectedModelIds: string[];
  onToggleModel: (modelId: string) => void;
  preferredModelId?: string;
  providers: CloudProviderInput[];
  onUpdateProviders: (providers: CloudProviderInput[]) => void;
  insufficientHardware: boolean;
}

function DrawerRow({
  icon,
  title,
  subtitle,
  children,
  toggleTestId,
  defaultExpanded = false,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
  toggleTestId?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="rounded-2xl border border-border bg-foreground/[0.015]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid={toggleTestId}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <span className="text-primary [&_svg]:h-5 [&_svg]:w-5">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-xs text-muted-foreground">{subtitle}</span>
        </span>
        <ChevronRight className={cn('h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && <div className="border-t border-border p-4">{children}</div>}
    </div>
  );
}

/** Collapsible "Advanced" panel holding the Other Models picker and Cloud API Keys inputs. */
export const AdvancedDrawers = ({
  recommendedModels,
  availableModels,
  selectedModelIds,
  onToggleModel,
  preferredModelId,
  providers,
  onUpdateProviders,
  insufficientHardware,
}: AdvancedDrawersProps) => {
  const [open, setOpen] = useState(true);

  return (
    <section className="rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="advanced-toggle"
        className="flex w-full items-center justify-between gap-3"
      >
        <h2 className="text-base font-bold uppercase tracking-wide text-primary sm:text-lg">Advanced</h2>
        <ChevronDown className={cn('h-5 w-5 text-primary transition-transform', !open && '-rotate-90')} />
      </button>

      {open && (
        <div className="mt-4 space-y-3">
          {!insufficientHardware && (
            <DrawerRow
              icon={<CubeModelsIcon />}
              title="Other Models"
              subtitle="Browse and select from more models."
              toggleTestId="other-models-toggle"
            >
              <OtherModels
                recommendedModels={recommendedModels}
                availableModels={availableModels}
                selectedModelIds={selectedModelIds}
                onToggleModel={onToggleModel}
                preferredModelId={preferredModelId}
              />
            </DrawerRow>
          )}

          <DrawerRow
            icon={<Cloud />}
            title="Cloud API Keys"
            subtitle="Add API keys for cloud providers."
            toggleTestId="cloud-toggle"
            defaultExpanded={insufficientHardware}
          >
            <CloudProviderCard providers={providers} insufficientHardware={insufficientHardware} onUpdate={onUpdateProviders} />
          </DrawerRow>
        </div>
      )}
    </section>
  );
};
