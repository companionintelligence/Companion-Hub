import { Card, CardContent } from '@/components/ui/Card';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import {
  ONBOARDING_BACKEND_DSPARK_HINT,
  ONBOARDING_BACKEND_LEMONADE_HINT,
  ONBOARDING_BACKEND_MTPLX_HINT,
  ONBOARDING_BACKEND_OLLAMA_HINT,
  ONBOARDING_BACKEND_SPECULATIVE_HINT,
  ONBOARDING_BACKEND_VLLM_HINT,
} from '@/components/hub-status/hub-status-tooltips';
import { BrandLogo, LemonadeIcon, SpeculativeInferenceIcon, VllmIcon } from './icons';
import { OptionCard, StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

const BACKEND_HINT_KEYS: Record<InferenceBackendType, string> = {
  ollama: ONBOARDING_BACKEND_OLLAMA_HINT,
  vllm: ONBOARDING_BACKEND_VLLM_HINT,
  lemonade: ONBOARDING_BACKEND_LEMONADE_HINT,
  mtplx: ONBOARDING_BACKEND_MTPLX_HINT,
  dspark: ONBOARDING_BACKEND_DSPARK_HINT,
  lucebox: ONBOARDING_BACKEND_SPECULATIVE_HINT,
};

const BACKEND_INFO: Record<InferenceBackendType, { label: string; descriptionKey?: string }> = {
  ollama: { label: 'Ollama', descriptionKey: 'ONBOARDING_BACKEND_OLLAMA_DESC' },
  vllm: { label: 'vLLM', descriptionKey: 'ONBOARDING_BACKEND_VLLM_DESC' },
  lemonade: { label: 'Lemonade', descriptionKey: 'ONBOARDING_BACKEND_LEMONADE_DESC' },
  mtplx: { label: 'MTPLX' },
  dspark: { label: 'mlx-dspark' },
  lucebox: { label: 'Speculative inference', descriptionKey: 'ONBOARDING_BACKEND_SPECULATIVE_DESC' },
};

/** Keep the Apple-Silicon speculative path prominent, with MTPLX as its variant. */
const BACKEND_ORDER: InferenceBackendType[] = ['dspark', 'mtplx', 'lucebox', 'ollama', 'vllm', 'lemonade'];

/** Runners that do speculative decoding, grouped under one heading in this order. */
const SPECULATIVE_GROUP_ORDER: InferenceBackendType[] = ['dspark', 'mtplx', 'lucebox'];

type BackendStatus = { type: InferenceBackendType; running: boolean; healthy: boolean };

interface BackendSelectionCardProps {
  recommended: InferenceBackendType;
  available: Array<{ type: InferenceBackendType; running: boolean; healthy: boolean }>;
  selected: InferenceBackendType;
  onSelect: (backend: InferenceBackendType) => void;
  disabled?: boolean;
  /** Remove the outer card when the selector is embedded inside a numbered setup step. */
  embedded?: boolean;
  /** Backend types that are known-unavailable and should be grayed out (unselectable). */
  unavailableTypes?: InferenceBackendType[];
  /** Backend types that do not apply to the detected host and should not be shown (unless already selected). */
  hiddenTypes?: InferenceBackendType[];
}

interface BackendOptionProps {
  backend: BackendStatus;
  recommended: InferenceBackendType;
  selected: InferenceBackendType;
  onSelect: (backend: InferenceBackendType) => void;
  disabled: boolean;
  unavailableTypes: InferenceBackendType[];
  nested?: boolean;
}

function BackendOption({ backend, recommended, selected, onSelect, disabled, unavailableTypes, nested = false }: BackendOptionProps) {
  const { t } = useTranslation();
  const { type, running, healthy } = backend;
  const info = BACKEND_INFO[type];
  const isRecommended = type === recommended;
  const isSelected = type === selected;
  const isUnavailable = unavailableTypes.includes(type);
  const isDisabled = disabled || isUnavailable;

  return (
    <label
      className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${
        nested ? 'ml-6 border-l border-primary/20 pl-4' : ''
      } ${isDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${
        isSelected && !isUnavailable ? 'bg-primary/5 ring-1 ring-primary/20' : isDisabled ? '' : 'hover:bg-muted/50'
      }`}
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
          <LabelWithHint label={info.label} hint={t(BACKEND_HINT_KEYS[type])} hintId={`backend-hint-${type}`} className="text-sm font-medium" />
          {isRecommended && !isUnavailable && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{t('ONBOARDING_RECOMMENDED')}</span>
          )}
          {isUnavailable ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted/50 text-muted-foreground font-medium">
              {t('ONBOARDING_UNAVAILABLE')}
            </span>
          ) : (
            <span
              className={`w-2 h-2 rounded-full ${healthy ? 'bg-success' : running ? 'bg-warning' : 'bg-muted-foreground/30'}`}
              title={healthy ? t('ONBOARDING_HEALTHY') : running ? t('COMMON_RUNNING') : t('ONBOARDING_NOT_RUNNING')}
            />
          )}
        </div>
        {info.descriptionKey && <div className="text-xs text-muted-foreground">{t(info.descriptionKey)}</div>}
      </div>
    </label>
  );
}

/**
 * Functional backend selector used by the Settings page (and reusable elsewhere). Onboarding uses
 * the simpler {@link BackendCard} instead.
 */
export const BackendSelectionCard = ({
  recommended,
  available,
  selected,
  onSelect,
  disabled = false,
  embedded = false,
  unavailableTypes = [],
  hiddenTypes = [],
}: BackendSelectionCardProps) => {
  const { t } = useTranslation();
  // Never hide the current selection, so an existing configuration stays visible and changeable.
  const visibleBackends = available.filter(({ type }) => type === selected || !hiddenTypes.includes(type));
  const backendsByType = new Map(visibleBackends.map((backend) => [backend.type, backend] as const));
  // Every runner that does speculative decoding shares one group. Its description follows the host:
  // mlx-dspark and MTPLX are only listed on Apple Silicon Macs, so without them the group is the GPU runner alone.
  const speculativeGroup = SPECULATIVE_GROUP_ORDER.flatMap((type) => backendsByType.get(type) ?? []);
  const hasAppleSiliconRunner = backendsByType.has('dspark') || backendsByType.has('mtplx');
  const speculativeGroupDescriptionKey = hasAppleSiliconRunner ? 'ONBOARDING_BACKEND_DSPARK_DESC' : 'ONBOARDING_BACKEND_SPECULATIVE_GPU_DESC';
  const orderedBackends = BACKEND_ORDER.filter((type) => backendsByType.has(type));

  const content = (
    <>
      {!embedded && (
        <>
          <h3 className="mb-1 text-sm font-semibold" data-testid="backend-card-title">
            {t('ONBOARDING_INFERENCE_BACKEND')}
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">{t('ONBOARDING_INFERENCE_BACKEND_DESC')}</p>
        </>
      )}

      <div className="space-y-1" data-testid="backend-options">
        {speculativeGroup.length > 0 && (
          <div className="space-y-1" data-testid="backend-option-speculative-group">
            <div className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('ONBOARDING_BACKEND_SPECULATIVE_GROUP')}
            </div>
            <p className="px-3 text-xs text-muted-foreground">{t(speculativeGroupDescriptionKey)}</p>
            <div className="space-y-1">
              {speculativeGroup.map((backend) => (
                <BackendOption
                  key={backend.type}
                  backend={backend}
                  recommended={recommended}
                  selected={selected}
                  onSelect={onSelect}
                  disabled={disabled}
                  unavailableTypes={unavailableTypes}
                  nested
                />
              ))}
            </div>
          </div>
        )}
        {orderedBackends
          .filter((type) => !SPECULATIVE_GROUP_ORDER.includes(type))
          .map((type) => {
            const backend = backendsByType.get(type);
            if (!backend) return null;
            return (
              <BackendOption
                key={type}
                backend={backend}
                recommended={recommended}
                selected={selected}
                onSelect={onSelect}
                disabled={disabled}
                unavailableTypes={unavailableTypes}
              />
            );
          })}
      </div>
    </>
  );

  if (embedded) {
    return <div data-testid="backend-selection-embedded">{content}</div>;
  }

  return (
    <Card className={disabled ? 'opacity-60' : undefined}>
      <CardContent className="p-4">{content}</CardContent>
    </Card>
  );
};

/**
 * Legacy static backend card retained for older consumers. The live selector above is the source
 * of truth and includes every backend returned by the profile.
 */
export const BackendCard = () => {
  const { t } = useTranslation();

  return (
    <StepSection number={2} title={t('ONBOARDING_INFERENCE_BACKEND')} description={t('ONBOARDING_CHOOSE_BACKEND_MODELS')}>
      <div className="grid gap-4 sm:grid-cols-3" data-testid="backend-card-title">
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
