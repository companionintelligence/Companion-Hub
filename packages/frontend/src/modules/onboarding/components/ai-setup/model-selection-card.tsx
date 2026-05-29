import type { CuratedModel, HardwareTier } from '@ci-hub/common/types';
import { ModelIcon } from './icons';
import { ModelCard, StepSection } from './primitives';

interface RecommendedModelsProps {
  tier: HardwareTier;
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  selectedModelIds: string[];
  onToggleModel: (modelId: string) => void;
  preferredModelId?: string;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

const MODALITY_TAG: Record<string, string> = {
  tts: 'Speech',
  stt: 'Transcription',
  embedding: 'Embedding',
  'image-gen': 'Image',
};

const PURPOSE_TAG: Record<string, string> = {
  fast: 'Fast',
  general: 'Balanced',
  coding: 'Coding',
  reasoning: 'Best for agents',
  transcription: 'Speech',
};

/** 1–2 short tags for a model, derived from its purpose/modality (matches the mock's pill style). */
function modelTags(model: CuratedModel): string[] {
  const modalityTag = model.modality && model.modality !== 'llm' ? MODALITY_TAG[model.modality] : undefined;
  if (modalityTag) return [modalityTag];
  const purpose = model.purpose as string | undefined;
  const purposeTag = purpose ? PURPOSE_TAG[purpose] : undefined;
  if (purposeTag) return [purposeTag];
  if (purpose) return [purpose.charAt(0).toUpperCase() + purpose.slice(1)];
  return [];
}

function modelMeta(model: CuratedModel): string {
  const ram = `${formatSize(model.runtime.memoryFootprintMb)} RAM`;
  return model.requirements?.diskMb == null ? ram : `${ram} · ${formatSize(model.requirements.diskMb)} disk`;
}

/** Step 3 — Recommended Models. Top catalog models for the detected hardware, as selectable tiles. */
export const RecommendedModels = ({
  tier,
  recommendedModels,
  availableModels,
  selectedModelIds,
  onToggleModel,
  preferredModelId,
}: RecommendedModelsProps) => {
  if (tier === 'insufficient') return null;

  const recommendedIds = new Set(recommendedModels.map((m) => m.id));
  const models = availableModels
    .filter((m) => recommendedIds.has(m.id))
    .sort((a, b) => Number(b.id === preferredModelId) - Number(a.id === preferredModelId));

  if (models.length === 0) return null;

  return (
    <StepSection number={3} title="Recommended Models" description="Top models that work great with your setup.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="model-card-title">
        {models.map((model) => (
          <ModelCard
            key={model.id}
            testId={`model-row-${model.id}`}
            checkboxTestId={`model-checkbox-${model.id}`}
            title={model.displayName}
            description={model.description}
            icon={<ModelIcon model={model} />}
            tags={modelTags(model)}
            selected={selectedModelIds.includes(model.id)}
            onToggle={() => onToggleModel(model.id)}
            agentDefault={model.id === preferredModelId}
            meta={modelMeta(model)}
          />
        ))}
      </div>
    </StepSection>
  );
};

interface OtherModelsProps {
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  selectedModelIds: string[];
  onToggleModel: (modelId: string) => void;
  preferredModelId?: string;
}

/** Compact list of non-recommended installable models, shown inside the Advanced drawer. */
export const OtherModels = ({ recommendedModels, availableModels, selectedModelIds, onToggleModel, preferredModelId }: OtherModelsProps) => {
  const recommendedIds = new Set(recommendedModels.map((m) => m.id));
  const models = availableModels.filter((m) => !recommendedIds.has(m.id));

  if (models.length === 0) {
    return <p className="text-xs text-muted-foreground">No additional models are available for your hardware.</p>;
  }

  return (
    <div className="space-y-1" data-testid="other-models-list">
      {models.map((model) => {
        const isSelected = selectedModelIds.includes(model.id);
        const isAgentDefault = model.id === preferredModelId;
        return (
          <label
            key={model.id}
            data-testid={`model-row-${model.id}`}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted/50"
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleModel(model.id)}
              className="rounded border-border"
              data-testid={`model-checkbox-${model.id}`}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium">{model.displayName}</span>
                {isAgentDefault && (
                  <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">Agent default</span>
                )}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{model.description}</span>
            </span>
            <span className="whitespace-nowrap text-right text-xs text-muted-foreground">{modelMeta(model)}</span>
          </label>
        );
      })}
    </div>
  );
};
