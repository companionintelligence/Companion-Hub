import { Card, CardContent } from '@/components/ui/Card';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import {
  ONBOARDING_BACKEND_LEMONADE_HINT,
  ONBOARDING_BACKEND_SPECULATIVE_HINT,
  ONBOARDING_BACKEND_OLLAMA_HINT,
  ONBOARDING_BACKEND_VLLM_HINT,
} from '@/components/hub-status/hub-status-tooltips';
import { BrandLogo, LemonadeIcon, SpeculativeInferenceIcon, VllmIcon } from './icons';
import { OptionCard, StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

const BACKEND_HINT_KEYS: Record<InferenceBackendType, string> = {
  ollama: ONBOARDING_BACKEND_OLLAMA_HINT,
  vllm: ONBOARDING_BACKEND_VLLM_HINT,
  lemonade: ONBOARDING_BACKEND_LEMONADE_HINT,
  lucebox: ONBOARDING_BACKEND_SPECULATIVE_HINT,
};

const BACKEND_INFO: Record<InferenceBackendType, { label: string; descriptionKey: string }> = {
  ollama: { label: 'Ollama', descriptionKey: 'ONBOARDING_BACKEND_OLLAMA_DESC' },
  vllm: { label: 'vLLM', descriptionKey: 'ONBOARDING_BACKEND_VLLM_DESC' },
  lemonade: { label: 'Lemonade', descriptionKey: 'ONBOARDING_BACKEND_LEMONADE_DESC' },
  lucebox: { label: 'Speculative inference', descriptionKey: 'ONBOARDING_BACKEND_SPECULATIVE_DESC' },
};

interface BackendSelectionCardProps {
  recommended: InferenceBackendType;
  available: Array<{ type: InferenceBackendType; running: boolean; healthy: boolean }>;
  selected: InferenceBackendType;
  onSelect: (backend: InferenceBackendType) => void;
  disabled?: boolean;
  /** Backend types that are known-unavailable and should be grayed out (unselectable). */
  unavailableTypes?: InferenceBackendType[];
}

/**
 * Functional backend selector used by the Settings page and onboarding.
 */
export const BackendSelectionCard = ({
  recommended,
  available,
  selected,
  onSelect,
  disabled = false,
  unavailableTypes = [],
}: BackendSelectionCardProps) => {
  const { t } = useTranslation();

  return (
    <Card className={disabled ? 'opacity-60' : undefined}>
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold mb-1" data-testid="backend-card-title">
          {t('ONBOARDING_INFERENCE_BACKEND')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">{t('ONBOARDING_INFERENCE_BACKEND_DESC')}</p>

        <div className="space-y-1" data-testid="backend-options">
          {available.map(({ type, running, healthy }) => {
            const info = BACKEND_INFO[type];
            const isRecommended = type === recommended;
            const isSelected = type === selected;
            const isUnavailable = unavailableTypes.includes(type);
            const isDisabled = disabled || isUnavailable;

            return (
              <label
                key={type}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                  isDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
                } ${isSelected && !isUnavailable ? 'bg-primary/5 ring-1 ring-primary/20' : isDisabled ? '' : 'hover:bg-muted/50'}`}
                data-testid={`backend-option-${type}`}
              >
                <input
                  type="radio"
                  name="inference-backend"
                  checked={isSelected && !isUnavailable}
                  disabled={isDisabled}
                  onChange={() => !isUnavailable && onSelect(type)}
                  className="text-primary"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <LabelWithHint
                      label={info.label}
                      hint={t(BACKEND_HINT_KEYS[type])}
                      hintId={`backend-hint-${type}`}
                      className="text-sm font-medium"
                    />
                    {isRecommended && !isUnavailable && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{t('ONBOARDING_RECOMMENDED')}</span>
                    )}
                    {isUnavailable ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted/50 text-muted-foreground font-medium">
                        {t('ONBOARDING_UNAVAILABLE')}
                      </span>
                    ) : (
                      <span
                        className={`w-2 h-2 rounded-full ${healthy ? 'bg-green-500' : running ? 'bg-yellow-500' : 'bg-muted-foreground/30'}`}
                        title={healthy ? t('ONBOARDING_HEALTHY') : running ? t('COMMON_RUNNING') : t('ONBOARDING_NOT_RUNNING')}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{t(info.descriptionKey)}</div>
                </div>
              </label>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};

/**
 * Legacy static onboarding card retained for callers that do not have a live backend status.
 */
export const BackendCard = () => {
  const { t } = useTranslation();

  return (
    <StepSection number={2} title={t('ONBOARDING_INFERENCE_BACKEND')} description={t('ONBOARDING_CHOOSE_BACKEND_MODELS')}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="backend-card-title">
        <OptionCard
          testId="backend-option-ollama"
          title="Ollama"
          description={t('ONBOARDING_BACKEND_OLLAMA_OPTION_DESC')}
          icon={<BrandLogo name="ollama" />}
          selected
          badge={t('ONBOARDING_DEFAULT')}
          hint={t(ONBOARDING_BACKEND_OLLAMA_HINT)}
        />
        <OptionCard
          testId="backend-option-vllm"
          title="vLLM"
          description={t('ONBOARDING_BACKEND_VLLM_OPTION_DESC')}
          icon={<VllmIcon />}
          disabled
          badge={t('ONBOARDING_SOON')}
          hint={t(ONBOARDING_BACKEND_VLLM_HINT)}
        />
        <OptionCard
          testId="backend-option-lemonade"
          title="Lemonade"
          description={t('ONBOARDING_BACKEND_LEMONADE_OPTION_DESC')}
          icon={<LemonadeIcon />}
          disabled
          badge={t('ONBOARDING_SOON')}
          hint={t(ONBOARDING_BACKEND_LEMONADE_HINT)}
        />
        <OptionCard
          testId="backend-option-speculative-inference"
          title="Speculative inference"
          description={t('ONBOARDING_BACKEND_SPECULATIVE_OPTION_DESC')}
          icon={<SpeculativeInferenceIcon />}
          disabled
          badge={t('ONBOARDING_SOON')}
          hint={t(ONBOARDING_BACKEND_SPECULATIVE_HINT)}
        />
      </div>
    </StepSection>
  );
};
