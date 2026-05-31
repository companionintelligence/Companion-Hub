import { Cloud } from 'lucide-react';
import type { CloudProviderInput } from '../../helpers/ai-setup-types';
import { CloudProviderCard } from './cloud-provider-card';
import { StepSection } from './primitives';

interface AdvancedDrawersProps {
  providers: CloudProviderInput[];
  onUpdateProviders: (providers: CloudProviderInput[]) => void;
  insufficientHardware: boolean;
}

/**
 * Step 4 — Advanced (optional). Holds the Cloud API Keys inputs, shown inline (no accordion) so they
 * conform to the other numbered steps. Other Models lives at the bottom of the Recommended Models step.
 */
export const AdvancedDrawers = ({ providers, onUpdateProviders, insufficientHardware }: AdvancedDrawersProps) => {
  return (
    <StepSection
      number={4}
      title="Advanced"
      action={<span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">Optional</span>}
    >
      <div className="mb-3 flex items-center gap-2">
        <Cloud className="h-5 w-5 text-primary" />
        <p className="text-sm font-semibold">Cloud API Keys</p>
      </div>
      <CloudProviderCard providers={providers} insufficientHardware={insufficientHardware} onUpdate={onUpdateProviders} />
    </StepSection>
  );
};
