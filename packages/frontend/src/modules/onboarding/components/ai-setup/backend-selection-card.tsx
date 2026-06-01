import { Card, CardContent } from '@/components/ui/Card';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { LabelWithHint } from '@/components/ui/field-hint/field-hint';
import {
  ONBOARDING_BACKEND_LEMONADE_HINT,
  ONBOARDING_BACKEND_OLLAMA_HINT,
  ONBOARDING_BACKEND_VLLM_HINT,
} from '@/components/hub-status/hub-status-tooltips';
import { BrandLogo, LemonadeIcon, VllmIcon } from './icons';
import { OptionCard, StepSection } from './primitives';

const BACKEND_HINTS: Record<InferenceBackendType, string> = {
  ollama: ONBOARDING_BACKEND_OLLAMA_HINT,
  vllm: ONBOARDING_BACKEND_VLLM_HINT,
  lemonade: ONBOARDING_BACKEND_LEMONADE_HINT,
};

const BACKEND_INFO: Record<InferenceBackendType, { label: string; description: string }> = {
  ollama: { label: 'Ollama', description: 'General-purpose inference. Works on all hardware.' },
  vllm: { label: 'vLLM', description: 'High-throughput GPU inference with tensor parallelism.' },
  lemonade: { label: 'Lemonade', description: 'NPU-optimized inference for supported hardware.' },
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
 * Functional backend selector used by the Settings page (and reusable elsewhere). Onboarding uses
 * the simpler {@link BackendCard} instead.
 */
export const BackendSelectionCard = ({
  recommended,
  available,
  selected,
  onSelect,
  disabled = false,
  unavailableTypes = [],
}: BackendSelectionCardProps) => {
  return (
    <Card className={disabled ? 'opacity-60' : undefined}>
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold mb-1" data-testid="backend-card-title">
          Inference Backend
        </h3>
        <p className="text-xs text-muted-foreground mb-3">The backend runs AI models locally on your hardware.</p>

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
                    <LabelWithHint label={info.label} hint={BACKEND_HINTS[type]} hintId={`backend-hint-${type}`} className="text-sm font-medium" />
                    {isRecommended && !isUnavailable && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">Recommended</span>
                    )}
                    {isUnavailable ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted/50 text-muted-foreground font-medium">
                        Unavailable
                      </span>
                    ) : (
                      <span
                        className={`w-2 h-2 rounded-full ${healthy ? 'bg-green-500' : running ? 'bg-yellow-500' : 'bg-muted-foreground/30'}`}
                        title={healthy ? 'Healthy' : running ? 'Running' : 'Not running'}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{info.description}</div>
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
 * Step 2 — Inference Backend (onboarding). Ollama is the only enabled backend for now and is
 * selected by default; vLLM and Lemonade are shown for context but disabled until they're supported
 * in onboarding. The orchestrator pins `selectedBackend` to 'ollama' to match.
 */
export const BackendCard = () => {
  return (
    <StepSection number={2} title="Inference Backend" description="Choose the backend that will run your models.">
      <div className="grid gap-4 sm:grid-cols-3" data-testid="backend-card-title">
        <OptionCard
          testId="backend-option-ollama"
          title="Ollama"
          description="Run models locally with Ollama."
          icon={<BrandLogo name="ollama" />}
          selected
          badge="Default"
          hint={ONBOARDING_BACKEND_OLLAMA_HINT}
        />
        <OptionCard
          testId="backend-option-vllm"
          title="vLLM"
          description="High-throughput inference backend."
          icon={<VllmIcon />}
          disabled
          badge="Soon"
          hint={ONBOARDING_BACKEND_VLLM_HINT}
        />
        <OptionCard
          testId="backend-option-lemonade"
          title="Lemonade"
          description="Companion Inference Engine."
          icon={<LemonadeIcon />}
          disabled
          badge="Soon"
          hint={ONBOARDING_BACKEND_LEMONADE_HINT}
        />
      </div>
    </StepSection>
  );
};
