import { cn } from '@/lib/utils';
import type { CuratedModel, HardwareTier, InferenceBackendType } from '@ci-hub/common/types';
import { ChevronRight, HardDrive, MemoryStick } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CubeModelsIcon, ModelIcon } from './icons';
import { ARTIFICIAL_ANALYSIS_URL, type LevelColor, LEVEL_TAG, LEVEL_TEXT, resourceColor, scoreColor, TIER_TAG_COLOR, TIER_TAG_LABEL } from './levels';
import { ModelCard, StepSection } from './primitives';
import { useTranslation } from 'react-i18next';

interface RecommendedModelsProps {
  tier: HardwareTier;
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  installedCatalogIds: string[];
  selectedModelIds: string[];
  onToggleModel: (modelId: string) => void;
  preferredModelId?: string;
  /** Chat backend — vLLM models open Hugging Face when not yet served. */
  chatBackend?: InferenceBackendType;
  /** Rendered at the bottom of the section (e.g. the collapsible Other Models drawer). */
  children?: ReactNode;
}

export function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

const MODALITY_TAG: Record<string, string> = {
  tts: 'ONBOARDING_MODEL_TAG_SPEECH',
  stt: 'ONBOARDING_MODEL_TAG_TRANSCRIPTION',
  embedding: 'ONBOARDING_MODEL_TAG_EMBEDDING',
  'image-gen': 'COMMON_IMAGE',
};

const MODALITY_FALLBACK_TAG: Record<string, string> = {
  tts: 'Speech',
  stt: 'Transcription',
  embedding: 'Embedding',
  'image-gen': 'Image',
};

/**
 * Capability pills for a model — what it can do, to help users pick the right local AI:
 * Reasoning / Vision / Tools / Audio (from catalog capability metadata) for LLMs, and a single
 * descriptive tag for non-LLM modalities (Embedding / Speech / Transcription).
 */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function modelTags(model: CuratedModel, t?: TranslateFn): string[] {
  if (model.modality && model.modality !== 'llm') {
    const key = MODALITY_TAG[model.modality];
    const fallback = MODALITY_FALLBACK_TAG[model.modality] ?? 'Model';
    return [t ? t(key ?? 'COMMON_MODEL') : fallback];
  }
  const caps = model.metadata?.capabilities;
  const tags: string[] = [];
  if (caps?.reasoning) tags.push(t ? t('ONBOARDING_MODEL_CAP_REASONING') : 'Reasoning');
  if (caps?.vision) tags.push(t ? t('ONBOARDING_MODEL_CAP_VISION') : 'Vision');
  if (caps?.tools) tags.push(t ? t('ONBOARDING_MODEL_CAP_TOOLS') : 'Tools');
  if (caps?.audio) tags.push(t ? t('ONBOARDING_MODEL_CAP_AUDIO') : 'Audio');
  if (tags.length > 0) return tags;
  // Fallback for entries without capability metadata.
  const purpose = model.purpose as string | undefined;
  return purpose ? [purpose.charAt(0).toUpperCase() + purpose.slice(1)] : [];
}

export function modelMeta(model: CuratedModel): ReactNode {
  return (
    <span className="flex items-center gap-3">
      <span className="flex items-center gap-1">
        <MemoryStick className="h-3 w-3 flex-shrink-0" />
        {formatSize(model.runtime.memoryFootprintMb)}
      </span>
      {model.requirements?.diskMb != null && (
        <span className="flex items-center gap-1">
          <HardDrive className="h-3 w-3 flex-shrink-0" />
          {formatSize(model.requirements.diskMb)}
        </span>
      )}
    </span>
  );
}

/** Artificial Analysis benchmark scores (0–100ish) shown on each model — intelligence + tool calling. */
export function modelScores(model: CuratedModel): { intelligence?: number; toolCalling?: number } {
  return { intelligence: model.metadata?.intelligenceIndex, toolCalling: model.metadata?.toolCallingIndex };
}

/** Step 2 — Recommended Models. Top catalog models for the detected hardware, as selectable tiles.
 * The collapsible Other Models drawer is rendered via `children` at the bottom of the section. */
export const RecommendedModels = ({
  tier,
  recommendedModels,
  availableModels,
  installedCatalogIds,
  selectedModelIds,
  onToggleModel,
  preferredModelId,
  chatBackend = 'ollama',
  children,
}: RecommendedModelsProps) => {
  const { t } = useTranslation();
  if (tier === 'insufficient') return null;

  const installed = new Set(installedCatalogIds);
  const recommendedIds = new Set(recommendedModels.map((m) => m.id));
  const models = availableModels
    .filter((m) => recommendedIds.has(m.id))
    .sort((a, b) => Number(b.id === preferredModelId) - Number(a.id === preferredModelId));

  const installHint =
    chatBackend === 'dspark'
      ? undefined
      : chatBackend === 'vllm'
        ? t('ONBOARDING_MODELS_VLLM_INSTALL_HINT')
        : chatBackend === 'mtplx'
          ? t('ONBOARDING_MODELS_MTPLX_INSTALL_HINT')
          : chatBackend === 'lemonade'
            ? t('ONBOARDING_MODELS_LEMONADE_INSTALL_HINT')
            : t('ONBOARDING_MODELS_INSTALL_AFTER_DOWNLOAD');

  return (
    <StepSection number={4} badge="recommended" title={t('ONBOARDING_MODELS_TITLE')}>
      <p className="mb-3 text-sm text-muted-foreground">{t('ONBOARDING_MODELS_CALLOUT')}</p>
      {installHint && <p className="mb-4 text-xs text-muted-foreground">{installHint}</p>}
      {models.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="model-card-title">
          {models.map((model) => (
            <ModelCard
              key={model.id}
              testId={`model-row-${model.id}`}
              checkboxTestId={`model-checkbox-${model.id}`}
              title={model.displayName}
              icon={<ModelIcon model={model} />}
              tags={modelTags(model, t)}
              selected={selectedModelIds.includes(model.id)}
              onToggle={() => onToggleModel(model.id)}
              agentDefault={model.id === preferredModelId}
              installed={installed.has(model.id)}
              meta={modelMeta(model)}
              scores={modelScores(model)}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('ONBOARDING_NO_RECOMMENDED_MODELS')}</p>
      )}
      {children}
    </StepSection>
  );
};

interface OtherModelsProps {
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  installedCatalogIds: string[];
  selectedModelIds: string[];
  onToggleModel: (modelId: string) => void;
  preferredModelId?: string;
}

/* ── Other Models table: color-coded levels (red → orange → gold → green → blue) live in ./levels ── */

function ScoreCell({ value }: { value?: number }) {
  const { t } = useTranslation();
  if (value == null) return <span className="text-muted-foreground/50">{t('COMMON_DASH')}</span>;
  return <span className={cn('font-semibold tabular-nums', LEVEL_TEXT[scoreColor(value)])}>{Math.round(value)}</span>;
}

function ResourceCell({ mb }: { mb?: number }) {
  const { t } = useTranslation();
  if (mb == null) return <span className="text-muted-foreground/50">{t('COMMON_DASH')}</span>;
  const gb = mb / 1024;
  return <span className={cn('tabular-nums', LEVEL_TEXT[resourceColor(gb)])}>{gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(mb)} MB`}</span>;
}

/** One model as a table row: select + name + colored tier / capability tags / scores / resources. */
function ModelTableRow({
  model,
  selected,
  isAgentDefault,
  isInstalled,
  onToggle,
}: {
  model: CuratedModel;
  selected: boolean;
  isAgentDefault: boolean;
  isInstalled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const tier = model.requirements.minTier;
  const inputId = `model-checkbox-${model.id}`;
  return (
    <tr
      data-testid={`model-row-${model.id}`}
      className={cn('border-t border-border/40 transition-colors hover:bg-muted/40', selected && 'bg-primary/[0.06]')}
    >
      <td className="py-2 pl-3 pr-2 align-middle">
        <input
          type="checkbox"
          id={inputId}
          checked={selected}
          onChange={onToggle}
          className="size-4 cursor-pointer rounded border-border accent-primary"
          data-testid={inputId}
        />
      </td>
      <td className="py-2 pr-3 align-middle">
        <label htmlFor={inputId} className="flex cursor-pointer items-center gap-2">
          <span className="flex-shrink-0 text-foreground/70 [&>*]:size-4">
            <ModelIcon model={model} />
          </span>
          <span className="whitespace-nowrap text-sm font-medium">{model.displayName}</span>
          {isAgentDefault && (
            <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">{t('ONBOARDING_DEFAULT')}</span>
          )}
          {isInstalled && (
            <span className="rounded bg-green-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white">{t('ONBOARDING_INSTALLED')}</span>
          )}
        </label>
      </td>
      <td className="py-2 pr-3 align-middle">
        <span
          className={cn('rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', LEVEL_TAG[TIER_TAG_COLOR[tier] ?? 'gold'])}
        >
          {TIER_TAG_LABEL[tier] ?? tier}
        </span>
      </td>
      <td className="py-2 pr-3 align-middle">
        <span className="flex flex-wrap gap-1">
          {modelTags(model, t).map((tag) => (
            <span key={tag} className="rounded border border-primary/30 px-1.5 py-0.5 text-[10px] font-medium text-primary/90">
              {tag}
            </span>
          ))}
        </span>
      </td>
      <td className="py-2 pr-3 text-right align-middle">
        <ScoreCell value={model.metadata?.intelligenceIndex} />
      </td>
      <td className="py-2 pr-3 text-right align-middle">
        <ScoreCell value={model.metadata?.toolCallingIndex} />
      </td>
      <td className="py-2 pr-3 text-right align-middle">
        <ResourceCell mb={model.runtime.memoryFootprintMb} />
      </td>
      <td className="py-2 pr-3 text-right align-middle">
        <ResourceCell mb={model.requirements.diskMb} />
      </td>
    </tr>
  );
}

interface OtherModelGroup {
  key: string;
  title: string;
  testId: string;
  color: LevelColor;
  items: CuratedModel[];
}

/** A color-coded, collapsible model category, rendered as a sortable-looking table when expanded. */
function ModelGroup({
  group,
  installedCatalogIds,
  selectedModelIds,
  onToggleModel,
  preferredModelId,
}: {
  group: OtherModelGroup;
  installedCatalogIds: string[];
  selectedModelIds: string[];
  onToggleModel: (id: string) => void;
  preferredModelId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const installed = new Set(installedCatalogIds);
  return (
    <div className={cn('overflow-hidden rounded-lg border', LEVEL_TAG[group.color])}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={group.testId}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight className={cn('h-4 w-4 flex-shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="flex-1 text-sm font-semibold">{group.title}</span>
        <span className="rounded-full bg-background/40 px-2 py-0.5 text-xs">{group.items.length}</span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-border/60 bg-card">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="w-8" aria-label={t('ONBOARDING_SELECT')} />
                <th className="py-1.5 pr-3 font-medium">{t('COMMON_MODEL')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('ONBOARDING_TIER')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('ONBOARDING_CAPABILITIES')}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t('ONBOARDING_INTELLIGENCE')}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t('ONBOARDING_TOOL_USE')}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t('ONBOARDING_RAM')}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t('COMMON_DISK')}</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((model) => (
                <ModelTableRow
                  key={model.id}
                  model={model}
                  selected={selectedModelIds.includes(model.id)}
                  isAgentDefault={model.id === preferredModelId}
                  isInstalled={installed.has(model.id)}
                  onToggle={() => onToggleModel(model.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Parameter-count ranges (small ≤14B, medium 15–70B, large >70B) plus embedding/speech. Each category
// gets its own level color, red → orange → gold → green → blue.
const OTHER_MODEL_GROUPS: { key: string; title: string; testId: string; color: LevelColor; match: (m: CuratedModel) => boolean }[] = [
  {
    key: 'large',
    title: 'Large models · 70B+',
    testId: 'other-group-large',
    color: 'red',
    match: (m) => m.modality === 'llm' && (m.parameterScale ?? 0) > 70,
  },
  {
    key: 'medium',
    title: 'Medium models · 15–70B',
    testId: 'other-group-medium',
    color: 'orange',
    match: (m) => m.modality === 'llm' && (m.parameterScale ?? 0) > 14 && (m.parameterScale ?? 0) <= 70,
  },
  {
    key: 'small',
    title: 'Small models · ≤14B',
    testId: 'other-group-small',
    color: 'gold',
    match: (m) => m.modality === 'llm' && (m.parameterScale ?? 0) <= 14,
  },
  { key: 'embedding', title: 'Embedding models', testId: 'other-group-embedding', color: 'green', match: (m) => m.modality === 'embedding' },
  {
    key: 'other',
    title: 'Speech & other models',
    testId: 'other-group-other',
    color: 'blue',
    match: (m) => m.modality !== 'llm' && m.modality !== 'embedding',
  },
];

/**
 * Non-recommended installable models, as a color-coded table grouped by parameter range (plus
 * embedding/speech). Each category is collapsed by default; rows show colored tier and capability
 * tags alongside intelligence / tool-use scores and RAM / disk. De-duplicated by id.
 */
export const OtherModels = ({
  recommendedModels,
  availableModels,
  installedCatalogIds,
  selectedModelIds,
  onToggleModel,
  preferredModelId,
}: OtherModelsProps) => {
  const { t } = useTranslation();
  const recommendedIds = new Set(recommendedModels.map((m) => m.id));
  // Exclude the recommended models and de-duplicate by id (guards against repeated entries).
  const models: CuratedModel[] = [];
  const seen = new Set<string>();
  for (const m of availableModels) {
    if (recommendedIds.has(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
  }

  if (models.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('ONBOARDING_NO_ADDITIONAL_MODELS')}</p>;
  }

  // Assign each model to the first matching group so it never appears twice.
  const assigned = new Set<string>();
  const groups: OtherModelGroup[] = OTHER_MODEL_GROUPS.map((group) => {
    const items = models.filter((m) => !assigned.has(m.id) && group.match(m));
    for (const m of items) assigned.add(m.id);
    const titleMap: Record<string, string> = {
      large: t('ONBOARDING_GROUP_LARGE_MODELS'),
      medium: t('ONBOARDING_GROUP_MEDIUM_MODELS'),
      small: t('ONBOARDING_GROUP_SMALL_MODELS'),
      embedding: t('ONBOARDING_GROUP_EMBEDDING_MODELS'),
      other: t('ONBOARDING_GROUP_SPEECH_OTHER_MODELS'),
    };
    return { ...group, title: titleMap[group.key] ?? group.title, items };
  }).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-2" data-testid="other-models-list">
      {groups.map((group) => (
        <ModelGroup
          key={group.key}
          group={group}
          installedCatalogIds={installedCatalogIds}
          selectedModelIds={selectedModelIds}
          onToggleModel={onToggleModel}
          preferredModelId={preferredModelId}
        />
      ))}
    </div>
  );
};

/**
 * Always-visible "Other Models" section at the bottom of the Recommended Models step (not a drawer).
 * The header is fixed; the long browse-all list stays tidy because each parameter-range group inside
 * {@link OtherModels} is itself collapsible.
 */
export const OtherModelsSection = (props: OtherModelsProps) => {
  const { t } = useTranslation();

  return (
    <div className="mt-4 rounded-md border border-border bg-foreground/[0.015] p-4">
      <div className="mb-3 flex items-center gap-3">
        <span className="text-primary [&_svg]:h-5 [&_svg]:w-5">
          <CubeModelsIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t('ONBOARDING_OTHER_MODELS')}</span>
        </span>
      </div>
      <OtherModels {...props} />
      <p className="mt-3 text-[11px] text-muted-foreground">
        {t('ONBOARDING_INTELLIGENCE_TOOLUSE_FROM')}{' '}
        <a
          href={ARTIFICIAL_ANALYSIS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {t('ONBOARDING_ARTIFICIAL_ANALYSIS')}
        </a>
        .
      </p>
    </div>
  );
};
