import { Card, CardContent } from '@/components/ui/Card';
import { BACKEND_DISPLAY_NAMES } from '@/lib/inference/backend-names';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import {
  ONBOARDING_BACKEND_LEMONADE_HINT,
  ONBOARDING_BACKEND_OLLAMA_HINT,
  ONBOARDING_BACKEND_OMLX_HINT,
  ONBOARDING_BACKEND_VLLM_HINT,
} from '@/components/hub-status/hub-status-tooltips';
import { BrandLogo, LemonadeIcon, VllmIcon } from './icons';
import { OptionCard, StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

const BACKEND_HINT_KEYS: Record<InferenceBackendType, string> = {
  ollama: ONBOARDING_BACKEND_OLLAMA_HINT,
  vllm: ONBOARDING_BACKEND_VLLM_HINT,
  lemonade: ONBOARDING_BACKEND_LEMONADE_HINT,
  omlx: ONBOARDING_BACKEND_OMLX_HINT,
};

const BACKEND_INFO: Record<InferenceBackendType, { label: string; descriptionKey?: string }> = {
  ollama: { label: BACKEND_DISPLAY_NAMES.ollama, descriptionKey: 'ONBOARDING_BACKEND_OLLAMA_DESC' },
  vllm: { label: BACKEND_DISPLAY_NAMES.vllm, descriptionKey: 'ONBOARDING_BACKEND_VLLM_DESC' },
  lemonade: { label: BACKEND_DISPLAY_NAMES.lemonade, descriptionKey: 'ONBOARDING_BACKEND_LEMONADE_DESC' },
  omlx: { label: BACKEND_DISPLAY_NAMES.omlx, descriptionKey: 'ONBOARDING_BACKEND_OMLX_DESC' },
};

const BACKEND_ORDER: InferenceBackendType[] = ['ollama', 'omlx', 'vllm', 'lemonade'];

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
  /**
   * Render as a checkbox that can be unticked. Unticking calls this instead of `onSelect`, so the
   * caller can return to the engine that was in use before.
   */
  onDeselect?: () => void;
}

function BackendOption({ backend, recommended, selected, onSelect, disabled, unavailableTypes, nested = false, onDeselect }: BackendOptionProps) {
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
        type={onDeselect ? 'checkbox' : 'radio'}
        name={onDeselect ? undefined : 'inference-backend'}
        checked={isSelected && !isUnavailable}
        disabled={isDisabled}
        onChange={() => {
          if (isUnavailable) return;
          if (onDeselect && isSelected) onDeselect();
          else onSelect(type);
        }}
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
        {orderedBackends.map((type) => {
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
          testId="backend-option-omlx"
          title="oMLX"
          description={t('ONBOARDING_BACKEND_OMLX_DESC')}
          icon={<BrandLogo name="ollama" />}
          disabled
          badge={t('ONBOARDING_SOON')}
          hint={t(ONBOARDING_BACKEND_OMLX_HINT)}
        />
      </div>
    </StepSection>
  );
};
