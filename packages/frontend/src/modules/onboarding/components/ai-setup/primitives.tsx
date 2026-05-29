import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

/* Shared presentational building blocks for the redesigned AI setup wizard. */

interface StepSectionProps {
  number: number;
  title: string;
  description?: string;
  children: ReactNode;
  /** Optional content rendered on the right of the section header (e.g. a tier badge). */
  action?: ReactNode;
  className?: string;
}

/** A numbered panel: cyan step badge + uppercase title + description, wrapping its content. */
export function StepSection({ number, title, description, children, action, className }: StepSectionProps) {
  return (
    <section className={cn('rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6', className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-sm font-semibold text-primary">
            {number}
          </span>
          <div>
            <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">{description}</p>}
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
  onSelect?: () => void;
  testId?: string;
}

/** A large, icon-led selectable card used for the Agent Framework and Inference Backend steps. */
export function OptionCard({ title, description, icon, selected = false, disabled = false, badge, onSelect, testId }: OptionCardProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        'group relative flex w-full flex-col gap-3 rounded-2xl border p-5 text-left transition-all',
        selected
          ? 'border-primary bg-primary/[0.06] shadow-lg shadow-primary/20'
          : 'border-border bg-foreground/[0.015] hover:border-primary/50 hover:bg-foreground/[0.03]',
        disabled && 'cursor-not-allowed opacity-45 hover:border-border hover:bg-foreground/[0.015]',
      )}
    >
      <span className="absolute right-4 top-4">
        <SelectIndicator selected={selected} />
      </span>
      <span className={cn('block [&_svg]:size-11', selected ? 'text-primary' : 'text-foreground/70 group-hover:text-foreground')}>{icon}</span>
      <span className="block pr-6">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{title}</span>
          {badge && (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{badge}</span>
          )}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

interface ModelCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  tags: string[];
  selected: boolean;
  onToggle: () => void;
  /** Pill marking the agent's default model. */
  agentDefault?: boolean;
  /** Right-aligned resource footer (RAM / disk). */
  meta?: ReactNode;
  testId?: string;
  checkboxTestId?: string;
}

/** A selectable model tile with family icon, tags, and resource footprint. */
export function ModelCard({ title, description, icon, tags, selected, onToggle, agentDefault, meta, testId, checkboxTestId }: ModelCardProps) {
  return (
    <label
      data-testid={testId}
      className={cn(
        'group relative flex h-full cursor-pointer flex-col gap-3 rounded-2xl border p-5 text-left transition-all',
        selected ? 'border-primary bg-primary/[0.06] shadow-lg shadow-primary/20' : 'border-border bg-foreground/[0.015] hover:border-primary/50',
      )}
    >
      <input type="checkbox" className="sr-only" checked={selected} onChange={onToggle} data-testid={checkboxTestId} />
      <span className="absolute right-4 top-4">
        <SelectIndicator selected={selected} />
      </span>
      <span className={cn('block [&_svg]:size-10', selected ? 'text-primary' : 'text-foreground/70 group-hover:text-foreground')}>{icon}</span>
      <span className="block pr-6">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{title}</span>
          {agentDefault && <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">Agent default</span>}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
      </span>
      {tags.length > 0 && (
        <span className="mt-auto flex flex-wrap gap-2 pt-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md border border-primary/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
            >
              {tag}
            </span>
          ))}
        </span>
      )}
      {meta && <span className="block text-xs text-muted-foreground">{meta}</span>}
    </label>
  );
}
