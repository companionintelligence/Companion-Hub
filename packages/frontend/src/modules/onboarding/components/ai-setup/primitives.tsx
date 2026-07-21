import { cn } from '@/lib/utils';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LEVEL_BG, LEVEL_TEXT, scoreColor } from './levels';

/* Shared presentational building blocks for the redesigned AI setup wizard. */

interface StepSectionProps {
  number: number;
  title: string;
  description?: string;
  /** Optional short tooltip beside the step title. */
  titleHint?: string;
  /** Section priority badge shown beside the title. */
  badge?: 'required' | 'recommended' | 'optional';
  children: ReactNode;
  /** Optional content rendered on the right of the section header (e.g. a tier badge). */
  action?: ReactNode;
  className?: string;
}

const BADGE_KEYS = {
  required: 'ONBOARDING_BADGE_REQUIRED',
  recommended: 'ONBOARDING_BADGE_RECOMMENDED',
  optional: 'ONBOARDING_BADGE_OPTIONAL',
} as const;

const BADGE_STYLES = {
  required: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  recommended: 'border-primary/30 bg-primary/10 text-primary',
  optional: 'border-border bg-muted text-muted-foreground',
} as const;

function StepSectionBadge({ badge }: { badge: 'required' | 'recommended' | 'optional' }) {
  const { t } = useTranslation();
  return <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium', BADGE_STYLES[badge])}>{t(BADGE_KEYS[badge])}</span>;
}

/** A numbered panel: cyan step badge + uppercase title + description, wrapping its content. */
export function StepSection({ number, title, description, titleHint, badge, children, action, className }: StepSectionProps) {
  return (
    <section className={cn('rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6', className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-sm font-semibold text-primary">
            {number}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">
                {titleHint ? (
                  <HintText id={`step-${number}-title`} hint={titleHint}>
                    {title}
                  </HintText>
                ) : (
                  title
                )}
              </h2>
              {badge && <StepSectionBadge badge={badge} />}
            </div>
            {description && <p className="mt-1 text-sm text-muted-foreground sm:text-base">{description}</p>}
          </div>
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** Circular selection marker — a filled cyan check when selected, an empty ring otherwise. */
export function SelectIndicator({ selected, className }: { selected: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
        className,
      )}
      aria-hidden="true"
    >
      {selected && <Check className="h-3 w-3" strokeWidth={3} />}
    </span>
  );
}

interface OptionCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  /** Small pill rendered next to the title (e.g. "Recommended", "Soon"). */
  badge?: string;
  /** Optional short tooltip beside the title. */
  hint?: string;
  onSelect?: () => void;
  testId?: string;
  className?: string;
}

/** A large, icon-led selectable card used for the Agent Framework and Inference Backend steps. */
export function OptionCard({
  title,
  description,
  icon,
  selected = false,
  disabled = false,
  badge,
  hint,
  onSelect,
  testId,
  className,
}: OptionCardProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        'group relative flex w-full items-start gap-4 rounded-md border p-4 text-left transition-all',
        selected
          ? 'border-primary bg-primary/[0.06] shadow-lg shadow-primary/20'
          : 'border-border bg-foreground/[0.015] hover:border-primary/50 hover:bg-foreground/[0.03]',
        disabled && 'cursor-not-allowed opacity-45 hover:border-border hover:bg-foreground/[0.015]',
        className,
      )}
    >
      <span className={cn('mt-0.5 flex-shrink-0 [&>*]:size-9', selected ? 'text-primary' : 'text-foreground/70 group-hover:text-foreground')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 pr-6">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">
            {hint ? (
              <HintText id={`option-${testId ?? title}`} hint={hint}>
                {title}
              </HintText>
            ) : (
              title
            )}
          </span>
          {badge && (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{badge}</span>
          )}
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span>
      </span>
      <span className="absolute right-3 top-3">
        <SelectIndicator selected={selected} />
      </span>
    </button>
  );
}

interface ModelCardProps {
  title: string;
  description?: string;
  icon: ReactNode;
  tags: string[];
  selected: boolean;
  onToggle: () => void;
  /** Pill marking the agent's default model. */
  agentDefault?: boolean;
  /** Pill when the model is already present in Ollama. */
  installed?: boolean;
  /** Right-aligned resource footer (RAM / disk). */
  meta?: ReactNode;
  /** Artificial Analysis benchmark scores (omitted fields are hidden). */
  scores?: { intelligence?: number; toolCalling?: number };
  testId?: string;
  checkboxTestId?: string;
}

/** A small labeled benchmark score with a proportional bar, colored by level (red → blue). */
function ScoreBar({ label, value, testId }: { label: string; value: number; testId?: string }) {
  const pct = Math.max(4, Math.min(100, (value / 60) * 100));
  const color = scoreColor(value);
  return (
    <span className="flex items-center gap-1.5" data-testid={testId}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
        <span className={cn('block h-full rounded-full', LEVEL_BG[color])} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('text-[11px] font-semibold tabular-nums', LEVEL_TEXT[color])}>{Math.round(value)}</span>
    </span>
  );
}

/** A selectable model tile with family icon, tags, benchmark scores, and resource footprint. */
export function ModelCard({
  title,
  description,
  icon,
  tags,
  selected,
  onToggle,
  agentDefault,
  installed,
  meta,
  scores,
  testId,
  checkboxTestId,
}: ModelCardProps) {
  const { t } = useTranslation();

  return (
    <label
      data-testid={testId}
      className={cn(
        'group relative flex h-full cursor-pointer flex-col gap-2.5 rounded-md border p-4 text-left transition-all',
        selected ? 'border-primary bg-primary/[0.06] shadow-lg shadow-primary/20' : 'border-border bg-foreground/[0.015] hover:border-primary/50',
      )}
    >
      <input type="checkbox" className="sr-only" checked={selected} onChange={onToggle} data-testid={checkboxTestId} />
      <span className="absolute right-3 top-3">
        <SelectIndicator selected={selected} />
      </span>
      {/* Icon + title inline */}
      <span className="flex items-center gap-2.5 pr-6">
        <span className={cn('flex-shrink-0 [&>*]:size-8', selected ? 'text-primary' : 'text-foreground/70 group-hover:text-foreground')}>{icon}</span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold leading-tight">{title}</span>
            {agentDefault && (
              <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {t('ONBOARDING_AGENT_DEFAULT')}
              </span>
            )}
            {installed && (
              <span className="rounded bg-green-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white">{t('ONBOARDING_INSTALLED')}</span>
            )}
          </span>
          {description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}
        </span>
      </span>
      {tags.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md border border-primary/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
            >
              {tag}
            </span>
          ))}
        </span>
      )}
      {scores && (scores.intelligence != null || scores.toolCalling != null) && (
        <span className="flex flex-wrap gap-x-3 gap-y-1" data-testid="model-scores">
          {scores.intelligence != null && <ScoreBar label={t('ONBOARDING_INTELLIGENCE')} value={scores.intelligence} testId="score-intelligence" />}
          {scores.toolCalling != null && <ScoreBar label={t('ONBOARDING_TOOL_USE')} value={scores.toolCalling} testId="score-tools" />}
        </span>
      )}
      {meta && <span className="block text-xs text-muted-foreground">{meta}</span>}
    </label>
  );
}
