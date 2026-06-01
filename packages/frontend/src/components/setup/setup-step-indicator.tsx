import clsx from 'clsx';
import type { ReactNode } from 'react';

export type SetupStepIndicatorState = 'active' | 'completed' | 'upcoming' | 'disabled';

interface SetupStepIndicatorProps {
  label: string;
  state: SetupStepIndicatorState;
  /** Icon or step number shown above the label */
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export function SetupStepIndicator({ label, state, icon, onClick, disabled, className }: SetupStepIndicatorProps) {
  // Clickability is driven solely by onClick/disabled — the caller decides when a step is
  // interactive (e.g. alwaysClickable future steps). `state` only controls visual appearance.
  const isClickable = Boolean(onClick) && !disabled;

  const content = (
    <>
      <span
        className={clsx(
          'flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-full text-xs font-semibold transition-all',
          state === 'active' && 'bg-primary text-primary-foreground ring-2 ring-primary/30',
          state === 'completed' && 'bg-accent text-foreground ring-1 ring-border',
          (state === 'upcoming' || state === 'disabled') && 'bg-secondary text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span
        className={clsx(
          'text-[10px] sm:text-xs font-medium text-center max-w-[4.5rem] sm:max-w-none leading-tight',
          state === 'active' && 'text-foreground',
          state === 'completed' && 'text-muted-foreground',
          (state === 'upcoming' || state === 'disabled') && 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </>
  );

  if (isClickable) {
    return (
      <li className={clsx('flex flex-col items-center gap-1.5', className)}>
        <button type="button" onClick={onClick} className="flex flex-col items-center gap-1.5 transition-colors hover:opacity-90">
          {content}
        </button>
      </li>
    );
  }

  return (
    <li className={clsx('flex flex-col items-center gap-1.5', className)}>
      <div className="flex flex-col items-center gap-1.5">{content}</div>
    </li>
  );
}
