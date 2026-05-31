import { cn } from '@/lib/utils';
import type { CuratedModel, HardwareTier } from '@ci-hub/common/types';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CubeModelsIcon, ModelIcon } from './icons';
import { ModelCard, StepSection } from './primitives';

interface RecommendedModelsProps {
  tier: HardwareTier;
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  selectedModelIds: string[];
  onToggleModel: (modelId: string) => void;
  preferredModelId?: string;
  /** Rendered at the bottom of the section (e.g. the collapsible Other Models drawer). */
  children?: ReactNode;
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

/** Step 2 — Recommended Models. Top catalog models for the detected hardware, as selectable tiles.
 * The collapsible Other Models drawer is rendered via `children` at the bottom of the section. */
export const RecommendedModels = ({
  tier,
  recommendedModels,
  availableModels,
  selectedModelIds,
  onToggleModel,
  preferredModelId,
  children,
}: RecommendedModelsProps) => {
  if (tier === 'insufficient') return null;

  const recommendedIds = new Set(recommendedModels.map((m) => m.id));
  const models = availableModels
    .filter((m) => recommendedIds.has(m.id))
    .sort((a, b) => Number(b.id === preferredModelId) - Number(a.id === preferredModelId));

  return (
    <StepSection
      number={2}
      title="Recommended Models"
      description="Your agents use the best fit for your hardware (pre-selected). Add more if you like — only checked models are installed."
    >
      {models.length > 0 ? (
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
      ) : (
        <p className="text-sm text-muted-foreground">No recommended models for your hardware — browse all installable models below.</p>
      )}
      {children}
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

/** One selectable model row (checkbox + name + meta), shared by the Other Models groups. */
function ModelRow({
  model,
  selected,
  isAgentDefault,
  onToggle,
}: {
  model: CuratedModel;
  selected: boolean;
  isAgentDefault: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      data-testid={`model-row-${model.id}`}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted/50"
    >
      <input type="checkbox" checked={selected} onChange={onToggle} className="rounded border-border" data-testid={`model-checkbox-${model.id}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{model.displayName}</span>
          {isAgentDefault && <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">Agent default</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{model.description}</span>
      </span>
      <span className="whitespace-nowrap text-right text-xs text-muted-foreground">{modelMeta(model)}</span>
    </label>
  );
}

/** Collapsible group of models inside the Other Models drawer. Collapsed by default. */
function ModelGroup({ title, count, testId, children }: { title: string; count: number; testId: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={testId}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight className={cn('h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="flex-1 text-sm font-medium">{title}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{count}</span>
      </button>
      {open && <div className="space-y-1 border-t border-border/60 p-2">{children}</div>}
    </div>
  );
}

// Parameter-count ranges for LLMs, mirroring the catalog's size classes (small ≤14B, medium 15–70B, large >70B).
const OTHER_MODEL_GROUPS: { key: string; title: string; testId: string; match: (m: CuratedModel) => boolean }[] = [
  { key: 'large', title: 'Large models · 70B+', testId: 'other-group-large', match: (m) => m.modality === 'llm' && (m.parameterScale ?? 0) > 70 },
  {
    key: 'medium',
    title: 'Medium models · 15–70B',
    testId: 'other-group-medium',
    match: (m) => m.modality === 'llm' && (m.parameterScale ?? 0) > 14 && (m.parameterScale ?? 0) <= 70,
  },
  { key: 'small', title: 'Small models · ≤14B', testId: 'other-group-small', match: (m) => m.modality === 'llm' && (m.parameterScale ?? 0) <= 14 },
  { key: 'embedding', title: 'Embedding models', testId: 'other-group-embedding', match: (m) => m.modality === 'embedding' },
  {
    key: 'other',
    title: 'Speech & other models',
    testId: 'other-group-other',
    match: (m) => m.modality !== 'llm' && m.modality !== 'embedding',
  },
];

/**
 * Non-recommended installable models, shown inside the Advanced drawer. LLMs are grouped by
 * parameter range and embedding models live in their own group; every group is collapsed by
 * default so the (often long) list stays hidden until the user opens a range.
 */
export const OtherModels = ({ recommendedModels, availableModels, selectedModelIds, onToggleModel, preferredModelId }: OtherModelsProps) => {
  const recommendedIds = new Set(recommendedModels.map((m) => m.id));
  const models = availableModels.filter((m) => !recommendedIds.has(m.id));

  if (models.length === 0) {
    return <p className="text-xs text-muted-foreground">No additional models are available for your hardware.</p>;
  }

  // Assign each model to the first matching group so it never appears twice.
  const assigned = new Set<string>();
  const groups = OTHER_MODEL_GROUPS.map((group) => {
    const items = models.filter((m) => !assigned.has(m.id) && group.match(m));
    for (const m of items) assigned.add(m.id);
    return { ...group, items };
  }).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-2" data-testid="other-models-list">
      {groups.map((group) => (
        <ModelGroup key={group.key} title={group.title} count={group.items.length} testId={group.testId}>
          {group.items.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              selected={selectedModelIds.includes(model.id)}
              isAgentDefault={model.id === preferredModelId}
              onToggle={() => onToggleModel(model.id)}
            />
          ))}
        </ModelGroup>
      ))}
    </div>
  );
};

/**
 * Collapsible "Other Models" drawer, collapsed by default, meant to sit at the bottom of the
 * Recommended Models section. Wraps the grouped {@link OtherModels} list so the (long) browse-all
 * set stays hidden until the user opens it.
 */
export const OtherModelsDrawer = (props: OtherModelsProps) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 rounded-2xl border border-border bg-foreground/[0.015]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="other-models-toggle"
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <span className="text-primary [&_svg]:h-5 [&_svg]:w-5">
          <CubeModelsIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Other Models</span>
          <span className="block text-xs text-muted-foreground">Install any model your hardware can run — including alternative embedders.</span>
        </span>
        <ChevronRight className={cn('h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t border-border p-4">
          <OtherModels {...props} />
        </div>
      )}
    </div>
  );
};
