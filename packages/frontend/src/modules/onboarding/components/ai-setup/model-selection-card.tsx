import { Card, CardContent } from '@/components/ui/Card';
import type { CuratedModel, HardwareTier } from '@ci-hub/common/types';

interface ModelSelectionCardProps {
  tier: HardwareTier;
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  selectedModelIds: string[];
  onToggleModel: (modelId: string) => void;
  /** Catalog id of the model Companion agents default to — shown with an "Agent default" marker. */
  preferredModelId?: string;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

const MODALITY_LABELS: Record<string, string> = {
  llm: 'Language Model',
  tts: 'Text-to-Speech',
  stt: 'Speech-to-Text',
  embedding: 'Embedding',
  'image-gen': 'Image Generation',
};

function groupByModality(models: CuratedModel[]): Record<string, CuratedModel[]> {
  const groups: Record<string, CuratedModel[]> = {};
  for (const model of models) {
    const key = model.modality;
    if (!groups[key]) groups[key] = [];
    groups[key].push(model);
  }
  return groups;
}

export const ModelSelectionCard = ({
  tier,
  recommendedModels,
  availableModels,
  selectedModelIds,
  onToggleModel,
  preferredModelId,
}: ModelSelectionCardProps) => {
  if (tier === 'insufficient') return null;

  const grouped = groupByModality(availableModels);
  const recommendedIds = new Set(recommendedModels.map((m) => m.id));
  // Surface the most relevant choices first: the agent default, then recommended, then the rest.
  const rank = (model: CuratedModel) => (model.id === preferredModelId ? 0 : recommendedIds.has(model.id) ? 1 : 2);

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold mb-1" data-testid="model-card-title">
          Local AI Models
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          Choose which models to install on your Hub. Recommended models are pre-selected for your hardware, and your agents’ default model is marked.
        </p>

        <div className="space-y-4" data-testid="model-groups">
          {Object.entries(grouped).map(([modality, models]) => (
            <div key={modality}>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{MODALITY_LABELS[modality] ?? modality}</div>
              <div className="space-y-1">
                {[...models]
                  .sort((a, b) => rank(a) - rank(b))
                  .map((model) => {
                    const isSelected = selectedModelIds.includes(model.id);
                    const isRecommended = recommendedIds.has(model.id);
                    const isAgentDefault = model.id === preferredModelId;

                    return (
                      <label
                        key={model.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                        data-testid={`model-row-${model.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleModel(model.id)}
                          className="rounded border-border"
                          data-testid={`model-checkbox-${model.id}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{model.displayName}</span>
                            {isAgentDefault && (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-primary text-primary-foreground font-medium"
                                data-testid={`model-agent-default-${model.id}`}
                              >
                                Agent default
                              </span>
                            )}
                            {isRecommended && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">Recommended</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{model.description}</div>
                        </div>
                        <div className="text-right text-xs text-muted-foreground whitespace-nowrap">
                          <div>{formatSize(model.runtime.memoryFootprintMb)} RAM</div>
                          {model.requirements?.diskMb != null && <div>{formatSize(model.requirements.diskMb)} disk</div>}
                        </div>
                      </label>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
