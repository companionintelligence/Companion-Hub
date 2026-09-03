import { Cloud } from 'lucide-react';
import type { CloudProviderInput } from '../../helpers/ai-setup-types';
import { CloudProviderCard } from './cloud-provider-card';
import { StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

interface AdvancedDrawersProps {
  providers: CloudProviderInput[];
  onUpdateProviders: (providers: CloudProviderInput[]) => void;
  insufficientHardware: boolean;
}

/**
 * Step 7 — Advanced (optional). Keep cloud credentials out of the primary setup path until the
 * operator explicitly opens the drawer. Other Models lives at the bottom of the Recommended Models step.
 */
export const AdvancedDrawers = ({ providers, onUpdateProviders, insufficientHardware }: AdvancedDrawersProps) => {
  const { t } = useTranslation();

  return (
    <StepSection number={7} badge="optional" title={t('COMMON_ADVANCED')} collapsible defaultOpen={false}>
      <div className="mb-3 flex items-center gap-2">
        <Cloud className="h-5 w-5 text-primary" />
        <p className="text-sm font-semibold">{t('ONBOARDING_CLOUD_API_KEYS')}</p>
      </div>
      <CloudProviderCard providers={providers} insufficientHardware={insufficientHardware} onUpdate={onUpdateProviders} />
    </StepSection>
  );
};
